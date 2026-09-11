import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  assertSelectedBackupState,
  emptyHierarchicalStateRoot,
  validateHierarchicalStateRoot,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  legacyCheckpointPrefix,
  migrateHierarchicalCheckpoint,
  rewriteCheckpointRoot,
} from "../scripts/backup_r2/migrate_hierarchical_checkpoint_generation.mjs";

const ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root";

function legacyRoot(version = "v2") {
  const source = legacyCheckpointPrefix(version);
  return {
    schema_version: 1,
    kind: ROOT_KIND,
    backup_version: "v2",
    ...(version === "v3" ? { observation_generation: "v3" } : {}),
    observations: { years: [{ year: "2026", months: [{
      state_shard_key: `${source}/observations/year=2026/month=09.json`,
    }] }] },
    global_units: { observation_run_manifests: {
      state_shard_key: `${source}/global/observation_run_manifests.json`,
    } },
    core: { state_shard_key: `${source}/global/core.json` },
    timeseries_binding: { ranges: [{
      state_shard_key: `${source}/timeseries_binding/range=000000-000999.json`,
    }] },
    timeseries_binding_packs: { ranges: [{
      state_shard_key: `${source}/timeseries_binding_packs/range=000000-000999.json`,
    }] },
  };
}

for (const version of ["v2", "v3"]) {
  test(`${version} checkpoint routing is explicit and self-identifying`, () => {
    const generation = getObservationHistoryGeneration(version);
    assert.equal(generation.backup_state_prefix,
      `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=${version}`);
    const root = emptyHierarchicalStateRoot(generation.backup_state_prefix, generation);
    assert.equal(root.observation_generation, version);
    assert.equal(validateHierarchicalStateRoot(root, generation.backup_state_prefix, generation).observation_generation, version);
    assert.throws(
      () => validateHierarchicalStateRoot({ ...root, observation_generation: version === "v2" ? "v3" : "v2" }, generation.backup_state_prefix, generation),
      /identity mismatch/,
    );
    assert.throws(
      () => assertSelectedBackupState(generation, { ...root, observation_generation: undefined }),
      /contradicts selected generation/,
    );
  });
}

test("empty checkpoint construction requires an explicit immutable generation", () => {
  assert.throws(() => emptyHierarchicalStateRoot(), /immutable shared generation/);
});

test("legacy checkpoint migration rewrites every root-owned state reference exactly", () => {
  const generation = getObservationHistoryGeneration("v2");
  const migrated = rewriteCheckpointRoot(legacyRoot(), generation, legacyCheckpointPrefix("v2"));
  const destination = generation.backup_state_prefix;
  assert.equal(migrated.backup_version, "v2");
  assert.equal(migrated.observation_generation, "v2");
  assert.deepEqual([
    migrated.observations.years[0].months[0].state_shard_key,
    migrated.global_units.observation_run_manifests.state_shard_key,
    migrated.core.state_shard_key,
    migrated.timeseries_binding.ranges[0].state_shard_key,
    migrated.timeseries_binding_packs.ranges[0].state_shard_key,
  ], [
    `${destination}/observations/year=2026/month=09.json`,
    `${destination}/global/observation_run_manifests.json`,
    `${destination}/global/core.json`,
    `${destination}/timeseries_binding/range=000000-000999.json`,
    `${destination}/timeseries_binding_packs/range=000000-000999.json`,
  ]);
});

for (const [name, invalidKey] of [
  ["already canonical v2", "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/global/core.json"],
  ["canonical v3 inside the v2 tree", "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/global/core.json"],
]) {
  test(`legacy v2 migration rejects ${name} state references`, () => {
    const root = legacyRoot();
    root.core.state_shard_key = invalidKey;
    assert.throws(
      () => rewriteCheckpointRoot(root, getObservationHistoryGeneration("v2"), legacyCheckpointPrefix("v2")),
      /outside the exact selected legacy namespace/,
    );
  });
}

test("legacy v2 migration rejects a mixed legacy and canonical root", () => {
  const root = legacyRoot();
  root.observations.years[0].months[0].state_shard_key =
    "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/observations/year=2026/month=09.json";
  assert.throws(
    () => rewriteCheckpointRoot(root, getObservationHistoryGeneration("v2"), legacyCheckpointPrefix("v2")),
    /outside the exact selected legacy namespace/,
  );
});

test("legacy v3 migration rejects absent generation identity", () => {
  const root = legacyRoot("v3");
  delete root.observation_generation;
  assert.throws(
    () => rewriteCheckpointRoot(root, getObservationHistoryGeneration("v3"), legacyCheckpointPrefix("v3")),
    /does not identify observation_generation v3/,
  );
});

test("apply migration requires the held observations global-operation lock before reading Dropbox", () => {
  assert.throws(
    () => migrateHierarchicalCheckpoint({
      dropboxRoot: "dropbox:TEST/R2_history_backup",
      version: "v2",
      apply: true,
      env: {},
    }),
    /valid coordinator-owned observations global operation lock context/,
  );
});

function migrationLockEnv() {
  const identity = observationsGlobalOperationLockIdentity();
  return {
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "r2_history_checkpoint_migration",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "checkpoint-migration:test",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

function validLegacyMigrationRoot() {
  const generation = getObservationHistoryGeneration("v2");
  const root = emptyHierarchicalStateRoot(generation.backup_state_prefix, generation);
  root.global_units.observation_run_manifests.state_shard_key =
    `${legacyCheckpointPrefix("v2")}/global/observation_run_manifests.json`;
  delete root.observation_generation;
  return root;
}

function migrationHarness({ root = validLegacyMigrationRoot(), checkStatus = 0, destinationCount = 1 } = {}) {
  const events = [];
  let publishedRoot = null;
  let destinationLists = 0;
  const operations = {
    cat(_bin, target) {
      if (target.endsWith("/observation_generation=v2/root.json")) {
        events.push("read_published_root");
        return publishedRoot;
      }
      events.push("read_legacy_root");
      return JSON.stringify(root);
    },
    catMaybe() {
      events.push("check_destination_root_absent");
      return { found: false, text: "" };
    },
    lsjsonRecursive(_bin, target) {
      if (target.endsWith("/observation_generation=v2")) {
        destinationLists += 1;
        events.push(destinationLists === 1 ? "check_destination_empty" : "count_non_root_destination");
        return destinationLists === 1 ? [] : Array.from({ length: destinationCount }, (_, index) => ({ Path: `global/${index}.json` }));
      }
      events.push("list_legacy_source");
      return [{ Path: "root.json" }, { Path: "global/observation_run_manifests.json" }];
    },
    run(_bin, args) {
      const operation = args[0];
      events.push(operation);
      if (operation === "check") return { status: checkStatus, stdout: "", stderr: "failed check" };
      if (operation === "copyto") publishedRoot = readFileSync(args[1], "utf8");
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const migrate = () => migrateHierarchicalCheckpoint({
    dropboxRoot: "dropbox:TEST/R2_history_backup",
    version: "v2",
    apply: true,
    env: migrationLockEnv(),
    operations,
  });
  return { events, migrate };
}

test("canonical root is not published when non-root rclone verification fails", () => {
  const harness = migrationHarness({ checkStatus: 1 });
  assert.throws(harness.migrate, /copy verification failed/);
  assert.equal(harness.events.includes("copyto"), false);
});

test("canonical root is not published when non-root file-count verification fails", () => {
  const harness = migrationHarness({ destinationCount: 0 });
  assert.throws(harness.migrate, /non-root file-count verification failed/);
  assert.equal(harness.events.includes("copyto"), false);
});

test("canonical root is not published when normal root validation fails", () => {
  const root = validLegacyMigrationRoot();
  root.schema_version = 999;
  const harness = migrationHarness({ root });
  assert.throws(harness.migrate, /schema_version mismatch/);
  assert.equal(harness.events.includes("copyto"), false);
});

test("canonical root is not published when selected-generation admission fails", () => {
  const root = validLegacyMigrationRoot();
  root.global_units.observations_timeseries_latest.source_relative_path =
    "history/_index_v3/observations_timeseries_latest.json";
  const harness = migrationHarness({ root });
  assert.throws(harness.migrate, /Object key is outside v2 latest/);
  assert.equal(harness.events.includes("copyto"), false);
});

test("successful migration publishes canonical root only after non-root verification", () => {
  const harness = migrationHarness();
  const report = harness.migrate();
  assert.equal(report.verified, true);
  assert.equal(report.destination_file_count, 2);
  assert.ok(harness.events.indexOf("copyto") > harness.events.indexOf("check"));
  assert.ok(harness.events.indexOf("copyto") > harness.events.indexOf("count_non_root_destination"));
  assert.ok(harness.events.indexOf("read_published_root") > harness.events.indexOf("copyto"));
});
