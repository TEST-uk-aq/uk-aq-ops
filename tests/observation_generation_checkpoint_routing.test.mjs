import assert from "node:assert/strict";
import test from "node:test";

import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  assertSelectedBackupState,
  emptyHierarchicalStateRoot,
  validateHierarchicalStateRoot,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  legacyCheckpointPrefix,
  rewriteCheckpointRoot,
} from "../scripts/backup_r2/migrate_hierarchical_checkpoint_generation.mjs";

for (const version of ["v2", "v3"]) {
  test(`${version} checkpoint routing is explicit and self-identifying`, () => {
    const generation = getObservationHistoryGeneration(version);
    assert.equal(
      generation.backup_state_prefix,
      `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=${version}`,
    );
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

test("legacy checkpoint migration rewrites every root-owned state reference and retains format v2", () => {
  const generation = getObservationHistoryGeneration("v2");
  const source = legacyCheckpointPrefix("v2");
  const root = emptyHierarchicalStateRoot();
  root.observations.years = [{ year: "2026", months: [{ state_shard_key: `${source}/observations/year=2026/month=09.json` }] }];
  root.core = { state_shard_key: `${source}/global/core.json` };
  root.timeseries_binding = { ranges: [{ state_shard_key: `${source}/timeseries_binding/range=000000-000999.json` }] };
  root.timeseries_binding_packs = { ranges: [{ state_shard_key: `${source}/timeseries_binding_packs/range=000000-000999.json` }] };
  const migrated = rewriteCheckpointRoot(root, generation, source);
  assert.equal(migrated.backup_version, "v2");
  assert.equal(migrated.observation_generation, "v2");
  for (const key of [
    migrated.observations.years[0].months[0].state_shard_key,
    migrated.global_units.observation_run_manifests.state_shard_key,
    migrated.core.state_shard_key,
    migrated.timeseries_binding.ranges[0].state_shard_key,
    migrated.timeseries_binding_packs.ranges[0].state_shard_key,
  ]) assert.ok(key.startsWith(`${generation.backup_state_prefix}/`));
});

test("legacy v3 migration rejects absent generation identity", () => {
  const generation = getObservationHistoryGeneration("v3");
  assert.throws(
    () => rewriteCheckpointRoot(emptyHierarchicalStateRoot(), generation, legacyCheckpointPrefix("v3")),
    /does not identify observation_generation v3/,
  );
});
