import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopedRootsInventoryShard,
  buildScopedRootsStateShard,
  emptyHierarchicalStateRoot,
  validateHierarchicalStateRoot,
} from "../lib/hierarchical_backup_v2.mjs";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { requireCompleteCheckpoint } from "../uk_aq_check_integrity_dropbox_currentness.mjs";

const sha = (character) => character.repeat(64);
const roots = [
  { day_utc: "2026-06-01", connector_id: 1, pollutant_code: "no2", key: "history/_index_v3/observations_timeseries/day_utc=2026-06-01/connector_id=1/pollutant_code=no2/manifest.json", sha256: sha("a"), byte_size: 101 },
  { day_utc: "2026-06-01", connector_id: 2, pollutant_code: "pm25", key: "history/_index_v3/observations_timeseries/day_utc=2026-06-01/connector_id=2/pollutant_code=pm25/manifest.json", sha256: sha("b"), byte_size: 202 },
];

test("v3 latest creates an exact, latest-bound scoped-root set", () => {
  const inventory = buildScopedRootsInventoryShard({ latestKey: "history/_index_v3/observations_timeseries_latest.json", latestSha256: sha("c"), latest: { day_summaries: [{ day_utc: "2026-06-01", scoped_roots: roots }] } });
  assert.equal(inventory.root_count, 2);
  assert.deepEqual(inventory.roots, roots);
  assert.equal(buildScopedRootsStateShard(inventory, [roots[0]]).complete, false);
  assert.equal(buildScopedRootsStateShard(inventory, roots.map((root) => ({ ...root, destination_verified: true }))).complete, true);
});

test("v3 latest rejects duplicate scope and contradictory keys", () => {
  const input = (scopedRoots) => ({ latestKey: "history/_index_v3/observations_timeseries_latest.json", latestSha256: sha("c"), latest: { day_summaries: [{ day_utc: "2026-06-01", scoped_roots: scopedRoots }] } });
  assert.throws(() => buildScopedRootsInventoryShard(input([roots[0], roots[0]])), /Duplicate/);
  assert.throws(() => buildScopedRootsInventoryShard(input([{ ...roots[0], key: roots[1].key }])), /contradicts/);
});

test("old v3 checkpoint remains readable but lacks scoped-root completeness", () => {
  const generation = getObservationHistoryGeneration("v3");
  const old = emptyHierarchicalStateRoot(generation.backup_state_prefix, generation);
  delete old.global_units.observations_timeseries_scoped_roots;
  const upgraded = validateHierarchicalStateRoot(old, generation.backup_state_prefix, generation);
  assert.equal(upgraded.global_units.observations_timeseries_scoped_roots.complete, false);
  assert.throws(() => requireCompleteCheckpoint(upgraded, "individual", generation), /scoped_roots_incomplete/);
});

test("v2 checkpoint shape is unchanged", () => {
  const generation = getObservationHistoryGeneration("v2");
  const state = emptyHierarchicalStateRoot(generation.backup_state_prefix, generation);
  assert.equal(state.global_units.observations_timeseries_scoped_roots, undefined);
});
