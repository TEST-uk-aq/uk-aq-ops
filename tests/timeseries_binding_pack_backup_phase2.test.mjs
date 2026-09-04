import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHierarchicalInventoryRoot,
  emptyHierarchicalStateRoot,
  resolveObservationsTimeseriesLatestPath,
  sha256Hex,
  stableJson,
  validateHierarchicalInventoryRoot,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  buildTimeseriesBindingPackInventoryReference,
  ISOLATED_TEST_PACK_BACKUP_DESTINATION,
  normalizeTimeseriesBindingBackupMode,
} from "../scripts/backup_r2/lib/timeseries_binding_pack_inventory_v1.mjs";
import {
  buildTimeseriesBindingBackupPackRootV1,
  timeseriesBindingBackupPackKey,
} from "../scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs";
import {
  syncTimeseriesBindingPacksToDropbox,
  TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
  timeseriesBindingPackRangeStateShardKey,
  validateTimeseriesBindingPackRangeState,
} from "../scripts/backup_r2/lib/hierarchical_timeseries_binding_pack_sync_v1.mjs";
import {
  buildTimeseriesBindingSourceRangeManifest,
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRangeManifestKey,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";
import {
  parseLockedHistoryBackupArgs,
  runLockedHistoryBackup,
} from "../scripts/backup_r2/uk_aq_run_locked_history_backup.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

const BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const PACK_PREFIX = "history/_backup_packs_v1/timeseries_binding";
const STATE_PREFIX = "_ops/checkpoints/r2_history_backup_state_v2";
const h = (character) => character.repeat(64);

function makePackInventory() {
  const sourceRanges = [
    buildTimeseriesBindingSourceRangeManifest({
      bindingPrefix: BINDING_PREFIX,
      rangeStart: 0,
      rangeEnd: 999,
      units: [{
        timeseries_id: 1,
        relative_path: `${BINDING_PREFIX}/timeseries_id=1.json`,
        sha256: h("1"),
        size: 11,
      }],
    }),
    buildTimeseriesBindingSourceRangeManifest({
      bindingPrefix: BINDING_PREFIX,
      rangeStart: 1000,
      rangeEnd: 1999,
      units: [{
        timeseries_id: 1001,
        relative_path: `${BINDING_PREFIX}/timeseries_id=1001.json`,
        sha256: h("2"),
        size: 12,
      }],
    }),
  ];
  const sourceRoot = buildTimeseriesBindingSourceRootManifest({
    bindingPrefix: BINDING_PREFIX,
    ranges: sourceRanges.map((range) => ({
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
  const packRoot = buildTimeseriesBindingBackupPackRootV1({
    sourceRootManifest: sourceRoot,
    packPrefix: PACK_PREFIX,
    ranges: sourceRanges.map((range, index) => ({
      range_start: range.range_start,
      range_end: range.range_end,
      source_range_hash: range.source_range_hash,
      pack_relative_path: timeseriesBindingBackupPackKey({
        packPrefix: PACK_PREFIX,
        rangeStart: range.range_start,
        rangeEnd: range.range_end,
        sourceRangeHash: range.source_range_hash,
      }),
      pack_sha256: h(index === 0 ? "a" : "b"),
      pack_size: index === 0 ? 101 : 202,
      member_count: range.units.length,
    })),
  });
  const result = buildTimeseriesBindingPackInventoryReference({
    sourceRootManifest: sourceRoot,
    packRootManifest: packRoot,
    packRootText: stableJson(packRoot),
    packPrefix: PACK_PREFIX,
  });
  return {
    sourceRoot,
    packRoot,
    reference: result.root_reference,
    report: result.report,
    inventoryRoot: { timeseries_binding_packs: result.root_reference },
  };
}

function makeHarness({ inventoryRoot, stateRoot = emptyHierarchicalStateRoot() } = {}) {
  const inventory = inventoryRoot.timeseries_binding_packs;
  const stateFiles = new Map();
  const copies = [];
  const identityReads = [];
  const writes = [];
  const destinationIdentities = new Map();
  const identityForPath = (relativePath) => {
    if (relativePath === inventory.pack_root_relative_path) {
      return {
        source_hash: inventory.pack_root_sha256,
        source_size: inventory.pack_root_size,
      };
    }
    const range = inventory.ranges.find(
      (entry) => entry.pack_relative_path === relativePath,
    );
    assert.ok(range, `unexpected copy path ${relativePath}`);
    return { source_hash: range.pack_sha256, source_size: range.pack_size };
  };
  return {
    stateRoot,
    stateFiles,
    copies,
    destinationIdentities,
    identityReads,
    writes,
    setDestinationRoot(value) {
      destinationIdentities.set(inventory.pack_root_relative_path, value);
    },
    setDestinationIdentity(relativePath, value) {
      destinationIdentities.set(relativePath, value);
    },
    deleteDestinationIdentity(relativePath) {
      destinationIdentities.delete(relativePath);
    },
    run({ dryRun = false, copyOverride = null } = {}) {
      return syncTimeseriesBindingPacksToDropbox({
        inventoryRoot,
        stateRoot,
        stateRootPrefix: STATE_PREFIX,
        dryRun,
        readStateJsonMaybe: (key) => stateFiles.get(key) || null,
        writeStateJson: (key, payload) => {
          const text = stableJson(payload);
          const result = { parsed: payload, text };
          stateFiles.set(key, result);
          writes.push(key);
          return { written: true, hash: sha256Hex(text) };
        },
        copyAndVerifyFile: (relativePath) => {
          copies.push(relativePath);
          const sourceIdentity = identityForPath(relativePath);
          const result = copyOverride
            ? copyOverride(relativePath, sourceIdentity)
            : { ...sourceIdentity, verified: !dryRun, dry_run: dryRun };
          if (!dryRun && result.verified) {
            destinationIdentities.set(relativePath, {
              exists: true,
              sha256: sourceIdentity.source_hash,
              size: sourceIdentity.source_size,
              verified: true,
            });
          }
          return result;
        },
        readDestinationFileIdentity: (relativePath) => {
          identityReads.push(relativePath);
          return destinationIdentities.get(relativePath)
            || { exists: false, sha256: null, size: null, verified: false };
        },
      });
    },
  };
}

function makeSyntheticInventory(rangeCount, memberCount) {
  const baseMembers = Math.floor(memberCount / rangeCount);
  let remainder = memberCount % rangeCount;
  const ranges = Array.from({ length: rangeCount }, (_, index) => {
    const rangeStart = index * 1000;
    const rangeEnd = rangeStart + 999;
    const sourceRangeHash = sha256Hex(`source-range-${index}`);
    const rangeMembers = baseMembers + (remainder > 0 ? 1 : 0);
    remainder -= remainder > 0 ? 1 : 0;
    return {
      range_start: rangeStart,
      range_end: rangeEnd,
      source_range_hash: sourceRangeHash,
      pack_relative_path: timeseriesBindingBackupPackKey({
        packPrefix: PACK_PREFIX,
        rangeStart,
        rangeEnd,
        sourceRangeHash,
      }),
      pack_sha256: sha256Hex(`pack-${index}`),
      pack_size: 100 + index,
      member_count: rangeMembers,
    };
  });
  return {
    timeseries_binding_packs: {
      schema_version: 1,
      kind: "uk_aq_r2_history_backup_inventory_timeseries_binding_packs",
      backup_pack_version: "v1",
      range_size: 1000,
      source_prefix: BINDING_PREFIX,
      source_root_key: `${BINDING_PREFIX}/_manifests/root.json`,
      source_root_hash: sha256Hex("synthetic-source-root"),
      pack_root_relative_path: `${PACK_PREFIX}/root.json`,
      pack_root_sha256: sha256Hex("synthetic-pack-root"),
      pack_root_size: 9999,
      range_count: rangeCount,
      member_count: memberCount,
      ranges,
    },
  };
}

function lockEnv() {
  const identity = observationsGlobalOperationLockIdentity();
  return {
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "r2_history_dropbox_backup",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "backup:phase2-test",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "phase2-test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

function lockedArgs(extra = [], historyIndexVersion = "v2") {
  return parseLockedHistoryBackupArgs([
    "--source-root", "uk_aq_r2:uk-aq-history-cic-test",
    "--dest-root", "uk_aq_dropbox:TEST/R2_history_backup",
    "--observations-prefix", "history/v2/observations",
    "--runs-prefix", "history/v2/_ops/observations/runs",
    "--core-prefix", "history/v2/core",
    "--timeseries-binding-prefix", BINDING_PREFIX,
    "--history-index-version", historyIndexVersion,
    "--inventory-root-prefix", "history/_index_v2/backup_inventory_v2",
    "--state-root-prefix", STATE_PREFIX,
    "--inventory-report-out", "tmp/inventory.json",
    "--backup-report-out", "tmp/backup.json",
    ...extra,
  ]);
}

test("pack inventory is derived from the source and pack roots and reuses exact identity", () => {
  const fixture = makePackInventory();
  assert.equal(fixture.reference.source_root_hash, fixture.sourceRoot.source_root_hash);
  assert.equal(fixture.reference.range_count, 2);
  assert.equal(fixture.reference.member_count, 2);
  assert.equal(fixture.report.derived_from_roots_only, true);
  const reused = buildTimeseriesBindingPackInventoryReference({
    sourceRootManifest: fixture.sourceRoot,
    packRootManifest: fixture.packRoot,
    packRootText: stableJson(fixture.packRoot),
    packPrefix: PACK_PREFIX,
    previousRootReference: fixture.reference,
  });
  assert.equal(reused.root_reference, fixture.reference);
  assert.equal(reused.report.inventory_reference_reused, true);
});

test("pack inventory rejects source-root mismatch, range mismatch and non-canonical root bytes", () => {
  const fixture = makePackInventory();
  assert.throws(
    () => buildTimeseriesBindingPackInventoryReference({
      sourceRootManifest: {
        ...fixture.sourceRoot,
        source_root_hash: h("9"),
      },
      packRootManifest: fixture.packRoot,
      packRootText: stableJson(fixture.packRoot),
      packPrefix: PACK_PREFIX,
    }),
    /source root hash mismatch/,
  );
  assert.throws(
    () => buildTimeseriesBindingPackInventoryReference({
      sourceRootManifest: fixture.sourceRoot,
      packRootManifest: {
        ...fixture.packRoot,
        ranges: [{
          ...fixture.packRoot.ranges[0],
          source_range_hash: h("8"),
        }, fixture.packRoot.ranges[1]],
      },
      packRootText: stableJson(fixture.packRoot),
      packPrefix: PACK_PREFIX,
    }),
    /root (?:path|source range) mismatch/,
  );
  assert.throws(
    () => buildTimeseriesBindingPackInventoryReference({
      sourceRootManifest: fixture.sourceRoot,
      packRootManifest: fixture.packRoot,
      packRootText: `${stableJson(fixture.packRoot)}\n`,
      packPrefix: PACK_PREFIX,
    }),
    /not canonical deterministic JSON/,
  );
});

test("old hierarchical inventory roots remain valid without pack reference", () => {
  const root = buildHierarchicalInventoryRoot({
    observationsRootManifestKey: "history/v2/observations/_manifests/manifest.json",
    observationsRootHash: h("1"),
    years: [],
    runManifestInventoryShardKey:
      "history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json",
    runManifestInventoryShardHash: h("2"),
    runManifestUnitCount: 0,
    latestTimeseries: {
      relative_path: "history/_index_v2/observations_timeseries_latest.json",
      sha256: h("3"),
      byte_size: 1,
    },
  });
  const validated = validateHierarchicalInventoryRoot(root);
  assert.equal(validated.timeseries_binding_packs, undefined);
  const invalidOptionalPack = {
    ...root,
    timeseries_binding_packs: { kind: "broken-optional-pack-reference" },
  };
  assert.doesNotThrow(() => validateHierarchicalInventoryRoot(
    invalidOptionalPack,
    { validateTimeseriesBindingPacks: false },
  ));
  assert.throws(
    () => validateHierarchicalInventoryRoot(invalidOptionalPack),
    /pack inventory reference identity mismatch/,
  );
});

test("fresh pack sync copies exactly one file per range, checkpoints separately, then copies root last", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  const result = harness.run();
  assert.deepEqual(harness.copies, [
    ...fixture.reference.ranges.map((range) => range.pack_relative_path),
    fixture.reference.pack_root_relative_path,
  ]);
  assert.equal(harness.writes.length, 2);
  assert.equal(result.report.packs_candidates, 2);
  assert.equal(result.report.packs_copied, 2);
  assert.equal(result.report.bytes_copied, 303);
  assert.equal(result.report.pack_root.copied, true);
  assert.equal(result.report.complete, true);
  assert.equal(harness.stateRoot.timeseries_binding_packs.verified, true);
  assert.equal(harness.stateRoot.timeseries_binding, undefined);
});

test("the current 143-range shape plans 143 pack transfers rather than 6265 member transfers", () => {
  const inventoryRoot = makeSyntheticInventory(143, 6265);
  const harness = makeHarness({ inventoryRoot });
  const result = harness.run();
  assert.equal(result.report.packs_total, 143);
  assert.equal(result.report.packs_candidates, 143);
  assert.equal(result.report.packs_copied, 143);
  assert.equal(harness.stateFiles.size, 143);
  assert.equal(harness.copies.length, 144);
  assert.equal(harness.copies.at(-1), `${PACK_PREFIX}/root.json`);
});

test("unchanged pack sync checks destination root identity and performs zero child copies", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  harness.writes.length = 0;
  const result = harness.run();
  assert.equal(result.report.packs_skipped, 2);
  assert.equal(result.report.pack_root.skipped, true);
  assert.equal(result.report.complete, true);
  assert.deepEqual(harness.copies, []);
  assert.deepEqual(harness.identityReads, [fixture.reference.pack_root_relative_path]);
  assert.equal(result.report.packs_destination_identity_checks, 0);
  assert.deepEqual(harness.writes, []);
});

test("a missing destination root checks every healthy child before repairing root last", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  harness.deleteDestinationIdentity(fixture.reference.pack_root_relative_path);
  const result = harness.run();
  assert.deepEqual(harness.copies, [fixture.reference.pack_root_relative_path]);
  assert.deepEqual(harness.identityReads, [
    fixture.reference.pack_root_relative_path,
    ...fixture.reference.ranges.map((range) => range.pack_relative_path),
  ]);
  assert.equal(result.report.packs_candidates, 0);
  assert.equal(result.report.packs_destination_identity_checks, 2);
  assert.equal(result.report.packs_destination_identity_matches, 2);
  assert.equal(result.report.pack_root.destination_missing_before_copy, true);
  assert.equal(result.report.pack_root.destination_missing, false);
  assert.equal(result.report.pack_root.copied, true);
});

test("a missing root and child checks every child, repairs only that child, then root", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  const missingChild = fixture.reference.ranges[0];
  harness.deleteDestinationIdentity(fixture.reference.pack_root_relative_path);
  harness.deleteDestinationIdentity(missingChild.pack_relative_path);
  const result = harness.run();
  assert.deepEqual(harness.identityReads, [
    fixture.reference.pack_root_relative_path,
    ...fixture.reference.ranges.map((range) => range.pack_relative_path),
  ]);
  assert.deepEqual(harness.copies, [
    missingChild.pack_relative_path,
    fixture.reference.pack_root_relative_path,
  ]);
  assert.deepEqual(harness.destinationIdentities.get(missingChild.pack_relative_path), {
    exists: true,
    sha256: missingChild.pack_sha256,
    size: missingChild.pack_size,
    verified: true,
  });
  assert.equal(result.report.packs_destination_identity_checks, 2);
  assert.equal(result.report.packs_destination_identity_mismatches, 1);
  assert.equal(result.report.packs_copied, 1);
  assert.equal(result.report.complete, true);
});

test("a wrong root and corrupt child repairs only that child before root", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  const corruptChild = fixture.reference.ranges[1];
  harness.setDestinationRoot({ exists: true, sha256: h("e"), size: 7, verified: true });
  harness.setDestinationIdentity(corruptChild.pack_relative_path, {
    exists: true,
    sha256: h("f"),
    size: corruptChild.pack_size,
    verified: true,
  });
  const result = harness.run();
  assert.deepEqual(harness.identityReads, [
    fixture.reference.pack_root_relative_path,
    ...fixture.reference.ranges.map((range) => range.pack_relative_path),
  ]);
  assert.deepEqual(harness.copies, [
    corruptChild.pack_relative_path,
    fixture.reference.pack_root_relative_path,
  ]);
  assert.deepEqual(harness.destinationIdentities.get(corruptChild.pack_relative_path), {
    exists: true,
    sha256: corruptChild.pack_sha256,
    size: corruptChild.pack_size,
    verified: true,
  });
  assert.equal(result.report.packs_destination_identity_matches, 1);
  assert.equal(result.report.packs_destination_identity_mismatches, 1);
  assert.equal(result.report.complete, true);
});

test("a failed child repair prevents root copy and completion", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  const missingChild = fixture.reference.ranges[0];
  harness.deleteDestinationIdentity(fixture.reference.pack_root_relative_path);
  harness.deleteDestinationIdentity(missingChild.pack_relative_path);
  assert.throws(
    () => harness.run({ copyOverride: (relativePath, identity) => {
      if (relativePath === missingChild.pack_relative_path) {
        throw new Error("injected repair failure");
      }
      return { ...identity, verified: true };
    } }),
    /injected repair failure/,
  );
  assert.deepEqual(harness.copies, [missingChild.pack_relative_path]);
  assert.equal(harness.copies.includes(fixture.reference.pack_root_relative_path), false);
  assert.equal(harness.stateRoot.timeseries_binding_packs.verified, false);
  assert.equal(harness.stateRoot.timeseries_binding_packs.processed_source_root_hash, null);
});

test("repair trusts destination evidence rather than a complete child checkpoint", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  const missingChild = fixture.reference.ranges[1];
  harness.deleteDestinationIdentity(fixture.reference.pack_root_relative_path);
  harness.deleteDestinationIdentity(missingChild.pack_relative_path);
  assert.ok(harness.stateRoot.timeseries_binding_packs.ranges.some(
    (range) => range.pack_relative_path === missingChild.pack_relative_path,
  ));
  const result = harness.run();
  assert.deepEqual(harness.copies, [
    missingChild.pack_relative_path,
    fixture.reference.pack_root_relative_path,
  ]);
  assert.equal(result.report.packs_copied, 1);
  assert.equal(result.report.complete, true);
});

test("a wrong root with all healthy children checks all children and recopies only root", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  harness.run();
  harness.copies.length = 0;
  harness.identityReads.length = 0;
  harness.setDestinationRoot({
    exists: true,
    sha256: h("d"),
    size: fixture.reference.pack_root_size,
    verified: true,
  });
  const result = harness.run();
  assert.deepEqual(harness.identityReads, [
    fixture.reference.pack_root_relative_path,
    ...fixture.reference.ranges.map((range) => range.pack_relative_path),
  ]);
  assert.deepEqual(harness.copies, [fixture.reference.pack_root_relative_path]);
  assert.equal(result.report.packs_destination_identity_checks, 2);
  assert.equal(result.report.packs_destination_identity_matches, 2);
  assert.equal(result.report.complete, true);
});

test("one changed range transfers one immutable pack plus root and retains unchanged pack state", () => {
  const fixture = makePackInventory();
  const stateRoot = emptyHierarchicalStateRoot();
  const first = makeHarness({ inventoryRoot: fixture.inventoryRoot, stateRoot });
  first.run();
  const changed = structuredClone(fixture.inventoryRoot);
  const range = changed.timeseries_binding_packs.ranges[1];
  range.source_range_hash = h("7");
  range.pack_sha256 = h("8");
  range.pack_size = 222;
  range.pack_relative_path = timeseriesBindingBackupPackKey({
    packPrefix: PACK_PREFIX,
    rangeStart: range.range_start,
    rangeEnd: range.range_end,
    sourceRangeHash: range.source_range_hash,
  });
  changed.timeseries_binding_packs.source_root_hash = h("6");
  changed.timeseries_binding_packs.pack_root_sha256 = h("5");
  changed.timeseries_binding_packs.pack_root_size += 1;
  const second = makeHarness({ inventoryRoot: changed, stateRoot });
  for (const [key, value] of first.stateFiles) second.stateFiles.set(key, value);
  for (const [key, value] of first.destinationIdentities) {
    second.destinationIdentities.set(key, value);
  }
  const result = second.run();
  assert.deepEqual(second.copies, [
    range.pack_relative_path,
    changed.timeseries_binding_packs.pack_root_relative_path,
  ]);
  assert.equal(result.report.packs_candidates, 1);
  assert.equal(result.report.packs_skipped, 1);
  assert.equal(stateRoot.timeseries_binding_packs.ranges.length, 2);
});

test("child failure prevents root copy and leaves root incomplete", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  assert.throws(
    () => harness.run({ copyOverride: (relativePath, identity) => {
      if (relativePath === fixture.reference.ranges[1].pack_relative_path) {
        throw new Error("injected child failure");
      }
      return { ...identity, verified: true };
    } }),
    /injected child failure/,
  );
  assert.deepEqual(harness.copies, fixture.reference.ranges.map(
    (range) => range.pack_relative_path,
  ));
  assert.equal(harness.stateRoot.timeseries_binding_packs.verified, false);
  assert.equal(harness.stateFiles.size, 1);
  harness.copies.length = 0;
  const resumed = harness.run();
  assert.deepEqual(harness.copies, [
    fixture.reference.ranges[1].pack_relative_path,
    fixture.reference.pack_root_relative_path,
  ]);
  assert.equal(resumed.report.packs_skipped, 1);
  assert.equal(resumed.report.complete, true);
});

test("root failure preserves verified child checkpoints but never completes root state", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  assert.throws(
    () => harness.run({ copyOverride: (relativePath, identity) => {
      if (relativePath === fixture.reference.pack_root_relative_path) {
        throw new Error("injected root failure");
      }
      return { ...identity, verified: true };
    } }),
    /injected root failure/,
  );
  assert.equal(harness.stateFiles.size, 2);
  assert.equal(harness.stateRoot.timeseries_binding_packs.verified, false);
  assert.equal(harness.stateRoot.timeseries_binding_packs.processed_source_root_hash, null);
});

test("pack dry-run plans packs and root but writes no checkpoints", () => {
  const fixture = makePackInventory();
  const harness = makeHarness(fixture);
  const result = harness.run({ dryRun: true });
  assert.equal(result.report.packs_dry_run, 2);
  assert.equal(result.report.pack_root.dry_run, true);
  assert.equal(result.report.complete, false);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.stateRoot.timeseries_binding_packs.verified, false);
});

test("pack state validator rejects the individual checkpoint kind", () => {
  assert.throws(
    () => validateTimeseriesBindingPackRangeState({
      schema_version: 1,
      kind: "uk_aq_r2_history_backup_state_timeseries_binding_range",
      backup_version: "v2",
      range_size: 1000,
      range_start: 0,
      range_end: 999,
      processed_source_range_hash: null,
      units: [],
    }, 0, 999),
    /pack range state identity mismatch/,
  );
  assert.equal(
    timeseriesBindingPackRangeStateShardKey(STATE_PREFIX, 0, 999),
    `${STATE_PREFIX}/timeseries_binding_packs/range=000000-000999.json`,
  );
  assert.notEqual(
    TIMESERIES_BINDING_PACK_RANGE_STATE_KIND,
    "uk_aq_r2_history_backup_state_timeseries_binding_range",
  );
});

test("mode validation is exact and pack-only destination guard is fail-closed", () => {
  assert.equal(normalizeTimeseriesBindingBackupMode("individual"), "individual");
  assert.equal(normalizeTimeseriesBindingBackupMode("dual"), "dual");
  assert.equal(normalizeTimeseriesBindingBackupMode("pack"), "pack");
  assert.throws(() => normalizeTimeseriesBindingBackupMode("DUAL"), /exactly/);
  assert.throws(
    () => lockedArgs(["--timeseries-binding-backup-mode", "pack"]),
    /requires --allow-experimental-pack-only/,
  );
  assert.throws(
    () => lockedArgs([
      "--timeseries-binding-backup-mode", "pack",
      "--allow-experimental-pack-only",
    ]),
    /forbidden against the normal TEST backup destination/,
  );
  const isolated = parseLockedHistoryBackupArgs([
    "--source-root", "uk_aq_r2:uk-aq-history-cic-test",
    "--dest-root", ISOLATED_TEST_PACK_BACKUP_DESTINATION,
    "--observations-prefix", "history/v2/observations",
    "--runs-prefix", "history/v2/_ops/observations/runs",
    "--core-prefix", "history/v2/core",
    "--timeseries-binding-prefix", BINDING_PREFIX,
    "--history-index-version", "v2",
    "--inventory-root-prefix", "history/_index_v2/backup_inventory_v2",
    "--state-root-prefix", STATE_PREFIX,
    "--inventory-report-out", "tmp/inventory.json",
    "--backup-report-out", "tmp/backup.json",
    "--timeseries-binding-backup-mode", "pack",
    "--allow-experimental-pack-only",
    "--timeseries-binding-packs-only",
  ]);
  assert.equal(isolated.timeseriesBindingPacksOnly, true);
});

test("locked wrapper keeps individual at two children and orders dual publisher before inventory and sync", () => {
  const individualCalls = [];
  runLockedHistoryBackup({
    args: lockedArgs(),
    env: lockEnv(),
    run: (_command, commandArgs) => {
      individualCalls.push(commandArgs);
      return { status: 0, signal: null, error: null };
    },
  });
  assert.equal(individualCalls.length, 2);
  assert.match(individualCalls[0][0], /build_backup_inventory\.mjs$/);
  assert.match(individualCalls[1][0], /sync_history_to_dropbox\.mjs$/);

  const dualCalls = [];
  runLockedHistoryBackup({
    args: lockedArgs(["--timeseries-binding-backup-mode", "dual", "--dry-run"]),
    env: lockEnv(),
    run: (_command, commandArgs) => {
      dualCalls.push(commandArgs);
      return { status: 0, signal: null, error: null };
    },
  });
  assert.equal(dualCalls.length, 3);
  assert.match(dualCalls[0][0], /publish_timeseries_binding_backup_packs\.mjs$/);
  assert.match(dualCalls[1][0], /build_backup_inventory\.mjs$/);
  assert.match(dualCalls[2][0], /sync_history_to_dropbox\.mjs$/);
  assert.equal(dualCalls[0].includes("--dry-run"), true);
  assert.equal(dualCalls[1].includes("--dry-run"), false);
  assert.equal(dualCalls[2].includes("--dry-run"), true);
});

test("locked wrapper forwards v2 and v3 unchanged and the resolver returns exact paths", () => {
  for (const [historyIndexVersion, expectedPath] of [
    ["v2", "history/_index_v2/observations_timeseries_latest.json"],
    ["v3", "history/_index_v3/observations_timeseries_latest.json"],
  ]) {
    const calls = [];
    runLockedHistoryBackup({
      args: lockedArgs([], historyIndexVersion),
      env: lockEnv(),
      run: (_command, commandArgs) => {
        calls.push(commandArgs);
        return { status: 0, signal: null, error: null };
      },
    });
    const inventoryArgs = calls.find(
      (commandArgs) => /build_backup_inventory\.mjs$/.test(commandArgs[0]),
    );
    assert.ok(inventoryArgs);
    const versionFlagIndex = inventoryArgs.indexOf("--history-index-version");
    assert.equal(inventoryArgs[versionFlagIndex + 1], historyIndexVersion);
    assert.equal(
      resolveObservationsTimeseriesLatestPath(historyIndexVersion),
      expectedPath,
    );
  }
});
