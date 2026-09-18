import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopedRootsInventoryShard,
  buildScopedRootsStateShard,
  emptyHierarchicalStateRoot,
  processScopedRootsCheckpoint,
  validateHierarchicalStateRoot,
} from "../lib/hierarchical_backup_v2.mjs";
import { getObservationHistoryGeneration } from "../../../workers/shared/uk_aq_observation_history_generation.mjs";
import { requireCompleteCheckpoint } from "../uk_aq_check_integrity_dropbox_currentness.mjs";
import { backupReportIsComplete } from "../sync_history_to_dropbox.mjs";

const sha = (character) => character.repeat(64);
const latestKey = "history/_index_v3/observations_timeseries_latest.json";
const indexRoot = "history/_index_v3/observations_timeseries";
const root = (connector, pollutant, character) => ({
  day_utc: "2026-06-01", connector_id: connector, pollutant_code: pollutant,
  key: `${indexRoot}/day_utc=2026-06-01/connector_id=${connector}/pollutant_code=${pollutant}/manifest.json`,
  byte_size: 100 + connector, sha256: sha(character), row_count: 5,
  timeseries_count: 1, child_shard_count: 1, physical_leaf_count: 1,
  physical_file_count: 1, min_observed_at_utc: "2026-06-01T00:00:00.000Z",
  max_observed_at_utc: "2026-06-01T01:00:00.000Z",
});
const roots = [root(1, "no2", "a"), root(2, "pm25", "b")];
const latest = (members = roots) => ({
  schema_version: 3, kind: "observation_timeseries_latest_global",
  index_generation: "v3", history_version: "v2", domain: "observations",
  history_schema_version: 3, writer_version: "parquet-wasm-zstd-v3", physical_layout_version: "timeseries-aligned-v2",
  aligned_row_cap: 1024, exact_leaf_index_version: "exact-timeseries-leaf-v1", index_root: indexRoot,
  min_day_utc: "2026-06-01", max_day_utc: "2026-06-01", day_count: 1,
  scoped_root_count: members.length, child_shard_count: members.length,
  physical_leaf_count: members.length, physical_file_reference_count: members.length,
  total_rows: members.reduce((sum, member) => sum + member.row_count, 0), days: ["2026-06-01"],
  key_layout: {
    scoped_manifest_key_template: `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}/manifest.json`,
    exact_leaf_key_template: `${indexRoot}/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}/timeseries_id={timeseries_id_9}.json`,
    aligned_source_index_root: `${indexRoot}/_aligned`, latest_key: latestKey,
  },
  day_summaries: [{ day_utc: "2026-06-01", row_count: members.reduce((sum, member) => sum + member.row_count, 0), scoped_root_count: members.length, connector_ids: members.map((member) => member.connector_id), pollutant_codes: members.map((member) => member.pollutant_code).sort(), scoped_roots: members }],
});
const inventory = () => buildScopedRootsInventoryShard({ latestKey, latestSha256: sha("c"), latest: latest() });

test("canonical exact-v3 latest is accepted and partial state stays incomplete", () => {
  const value = inventory();
  assert.equal(value.root_count, 2);
  assert.equal(buildScopedRootsStateShard(value, [{ ...value.roots[0], destination_verified: true }]).complete, false);
});

test("production validator rejects wrong, empty, duplicate, and counter-inconsistent latest", () => {
  assert.throws(() => buildScopedRootsInventoryShard({ latestKey, latestSha256: sha("c"), latest: { ...latest(), index_generation: "v2" } }), /contradictory/);
  assert.throws(() => buildScopedRootsInventoryShard({ latestKey, latestSha256: sha("c"), latest: { day_summaries: [] } }), /requires scoped roots/);
  assert.throws(() => buildScopedRootsInventoryShard({ latestKey, latestSha256: sha("c"), latest: latest([roots[0], roots[0]]) }), /duplicate/);
  assert.throws(() => buildScopedRootsInventoryShard({ latestKey, latestSha256: sha("c"), latest: { ...latest(), scoped_root_count: 99 } }), /counters/);
});

test("scoped-root checkpoints batch, resume compatible state, and reject stale identity", async () => {
  const value = inventory();
  const destinations = new Map(value.roots.map((entry) => [entry.key, { exists: true, sha256: entry.sha256, size: entry.byte_size }]));
  const flushed = [];
  const first = await processScopedRootsCheckpoint({ inventory: value, checkpointBatchUnits: 2, checkpointFlushSeconds: 60, inspectDestination: async (entry) => destinations.get(entry.key), copyAndVerify: async () => assert.fail("copy not expected"), flushState: async (state) => flushed.push(state) });
  assert.equal(first.flush_count, 1);
  assert.equal(first.state.complete, true);
  const resumed = await processScopedRootsCheckpoint({ inventory: value, priorState: first.state, checkpointBatchUnits: 10, checkpointFlushSeconds: 60, inspectDestination: async (entry) => destinations.get(entry.key), copyAndVerify: async () => {}, flushState: async () => {} });
  assert.equal(resumed.prior_compatible, true);
  const changed = { ...value, global_latest_sha256: sha("d") };
  const stale = await processScopedRootsCheckpoint({ inventory: changed, priorState: first.state, checkpointBatchUnits: 10, checkpointFlushSeconds: 60, inspectDestination: async (entry) => destinations.get(entry.key), copyAndVerify: async () => {}, flushState: async () => {} });
  assert.equal(stale.prior_compatible, false);
});

test("failure force-flushes verified progress", async () => {
  const value = inventory();
  const flushed = [];
  let calls = 0;
  await assert.rejects(processScopedRootsCheckpoint({ inventory: value, checkpointBatchUnits: 10, checkpointFlushSeconds: 60, inspectDestination: async (entry) => (++calls === 1 ? { exists: true, sha256: entry.sha256, size: entry.byte_size } : { exists: false }), copyAndVerify: async () => { throw new Error("simulated"); }, flushState: async (state) => flushed.push(state) }), /simulated/);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].complete, false);
  assert.equal(flushed[0].roots.filter((entry) => entry.destination_verified).length, 1);
});

test("old v3 is readable but incomplete, while v2 and report semantics remain compatible", () => {
  const v3 = getObservationHistoryGeneration("v3");
  const old = emptyHierarchicalStateRoot(v3.backup_state_prefix, v3);
  delete old.global_units.observations_timeseries_scoped_roots;
  const upgraded = validateHierarchicalStateRoot(old, v3.backup_state_prefix, v3);
  assert.throws(() => requireCompleteCheckpoint(upgraded, "individual", v3), /scoped_roots_incomplete/);
  const v2 = getObservationHistoryGeneration("v2");
  assert.equal(emptyHierarchicalStateRoot(v2.backup_state_prefix, v2).global_units.observations_timeseries_scoped_roots, undefined);
  const report = { observations: { incomplete_months: [], incomplete_years: [] }, timeseries_binding: { incomplete_ranges: [] }, timeseries_binding_packs: { complete: true }, core: { complete: true }, run_manifests: { complete: true }, latest_timeseries: { incomplete: false }, scoped_roots: { complete: false } };
  assert.equal(backupReportIsComplete(report, "v2"), true);
  assert.equal(backupReportIsComplete(report, "v3"), false);
});
