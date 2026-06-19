// Minimal tests for the R2 history Dropbox backup inventory plumbing.
//
// Scope (per the plan):
// - planDays: unchanged day not queued
// - planDays: changed old day queued
// - planDays: new day queued
// - validateInventoryPayload: missing inventory fails loudly in strict mode

import test from "node:test";
import assert from "node:assert/strict";

import {
  planDays,
  planIndexFiles,
  planIndexTreeUnits,
  planRunManifestUnits,
  sanitizeCheckpointState,
} from "../scripts/backup_r2/sync_history_to_dropbox.mjs";
import { isRunManifestUnitPath } from "../scripts/backup_r2/build_backup_inventory.mjs";
import {
  defaultInventoryRelPathForBackupVersion,
  defaultStateRelPathForBackupVersion,
  domainNamesForBackupVersion,
  INVENTORY_KIND,
  INVENTORY_SCHEMA_VERSION,
  indexFileKeysForBackupVersion,
  indexTreeKeysForBackupVersion,
  resolveBackupVersion,
  runManifestPrefixForBackupVersion,
  validateInventoryPayload,
} from "../scripts/backup_r2/lib/inventory.mjs";

function makeInventory({ backupVersion = "v1", days = {}, indexFiles = {}, indexTreeUnits = {}, runManifestUnits = {} } = {}) {
  const tree = {
    observations_timeseries: { units: {} },
    aqilevels_timeseries: { units: {} },
    observations_timeseries_v2: { units: {} },
    aqilevels_hourly_data_timeseries_v2: { units: {} },
  };
  for (const [key, units] of Object.entries(indexTreeUnits)) {
    tree[key] = { units };
  }
  return {
    version: INVENTORY_SCHEMA_VERSION,
    kind: INVENTORY_KIND,
    backup_version: backupVersion,
    generated_at: "2026-05-15T00:00:00.000Z",
    source: { index_prefix: "history/_index", domain_prefixes: {} },
    domains: {
      observations: { days: days.observations || {} },
      aqilevels: { days: days.aqilevels || {} },
      core: { days: days.core || {} },
    },
    index_files: indexFiles,
    index_tree_units: tree,
    run_manifest_units: { observations: { units: runManifestUnits.observations || {} } },
    summary: {},
  };
}

function makeCheckpoint({ days = {}, indexFiles = {}, indexTreeUnits = {}, runManifestUnits = {} } = {}) {
  const buildDomain = (dayMap) => ({
    days: dayMap,
    last_successful_day_utc: null,
    last_successful_copy_at: null,
  });
  const tree = {
    observations_timeseries: { units: {} },
    aqilevels_timeseries: { units: {} },
    observations_timeseries_v2: { units: {} },
    aqilevels_hourly_data_timeseries_v2: { units: {} },
  };
  for (const [key, units] of Object.entries(indexTreeUnits)) {
    tree[key] = { units };
  }
  return {
    version: 1,
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    domains: {
      observations: buildDomain(days.observations || {}),
      aqilevels: buildDomain(days.aqilevels || {}),
      core: buildDomain(days.core || {}),
    },
    index_files: indexFiles,
    index_tree_units: tree,
    run_manifest_units: { observations: { units: runManifestUnits.observations || {} } },
  };
}

function obsDayInventoryEntry(dayUtc, hash) {
  return {
    unit_type: "day_folder",
    relative_path: `history/v1/observations/day_utc=${dayUtc}`,
    manifest_relative_path: `history/v1/observations/day_utc=${dayUtc}/manifest.json`,
    manifest_hash: hash,
    manifest_size: 1234,
  };
}

function obsDayCheckpointEntry(dayUtc, hash) {
  return {
    manifest_key: `history/v1/observations/day_utc=${dayUtc}/manifest.json`,
    copied_at: "2026-05-14T00:00:00.000Z",
    manifest_hash: hash,
  };
}

const SYNC_ARGS = {
  domains: ["observations", "aqilevels", "core"],
  max_days_per_run: 0,
};

// ----- planDays -----

test("planDays: unchanged day is skipped, not queued", () => {
  const inventory = makeInventory({
    days: { observations: { "2026-05-10": obsDayInventoryEntry("2026-05-10", "hashA") } },
  });
  const state = makeCheckpoint({
    days: { observations: { "2026-05-10": obsDayCheckpointEntry("2026-05-10", "hashA") } },
  });

  const plan = planDays(inventory, state, SYNC_ARGS);

  assert.equal(plan.observations.listed_days, 1);
  assert.equal(plan.observations.candidate_days, 0);
  assert.equal(plan.observations.skipped_unchanged, 1);
  assert.deepEqual(plan.observations.candidates, []);
});

test("planDays: changed old day is queued", () => {
  const inventory = makeInventory({
    days: { observations: { "2026-05-10": obsDayInventoryEntry("2026-05-10", "newHash") } },
  });
  const state = makeCheckpoint({
    days: { observations: { "2026-05-10": obsDayCheckpointEntry("2026-05-10", "oldHash") } },
  });

  const plan = planDays(inventory, state, SYNC_ARGS);

  assert.equal(plan.observations.candidate_days, 1);
  assert.equal(plan.observations.skipped_unchanged, 0);
  assert.equal(plan.observations.candidates[0].day_utc, "2026-05-10");
  assert.equal(plan.observations.candidates[0].inventory_entry.manifest_hash, "newHash");
});

test("planDays: new day (not in checkpoint) is queued", () => {
  const inventory = makeInventory({
    days: { observations: { "2026-05-11": obsDayInventoryEntry("2026-05-11", "freshHash") } },
  });
  const state = makeCheckpoint({}); // empty checkpoint — first run

  const plan = planDays(inventory, state, SYNC_ARGS);

  assert.equal(plan.observations.candidate_days, 1);
  assert.equal(plan.observations.skipped_unchanged, 0);
  assert.equal(plan.observations.candidates[0].day_utc, "2026-05-11");
  assert.equal(plan.observations.candidates[0].inventory_entry.manifest_hash, "freshHash");
});

test("planDays: max_days_per_run throttles candidates per domain", () => {
  const inventory = makeInventory({
    days: {
      observations: {
        "2026-05-10": obsDayInventoryEntry("2026-05-10", "h1"),
        "2026-05-11": obsDayInventoryEntry("2026-05-11", "h2"),
        "2026-05-12": obsDayInventoryEntry("2026-05-12", "h3"),
      },
    },
  });
  const state = makeCheckpoint({}); // all three days new

  const plan = planDays(inventory, state, { ...SYNC_ARGS, max_days_per_run: 2 });

  assert.equal(plan.observations.candidate_days, 2);
  assert.equal(plan.observations.skipped_by_limit, 1);
});

// ----- planIndexFiles / planIndexTreeUnits -----

test("planIndexFiles: unchanged file skipped, changed file queued", () => {
  const inventory = makeInventory({
    indexFiles: {
      observations_latest: {
        unit_type: "file",
        relative_path: "history/_index/observations_latest.json",
        hash: "hashA",
        size: 100,
      },
      aqilevels_latest: {
        unit_type: "file",
        relative_path: "history/_index/aqilevels_latest.json",
        hash: "hashB-new",
        size: 100,
      },
    },
  });
  const state = makeCheckpoint({
    indexFiles: {
      observations_latest: { hash: "hashA", relative_path: "history/_index/observations_latest.json", size: 100, copied_at: "" },
      aqilevels_latest: { hash: "hashB-old", relative_path: "history/_index/aqilevels_latest.json", size: 100, copied_at: "" },
    },
  });

  const candidates = planIndexFiles(inventory, state);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index_key, "aqilevels_latest");
});

test("planIndexTreeUnits: unchanged unit skipped, changed unit queued", () => {
  const inventory = makeInventory({
    indexTreeUnits: {
      observations_timeseries: {
        "day_utc=2026-05-10/connector_id=6/manifest.json": {
          unit_type: "file",
          relative_path: "history/_index/observations_timeseries/day_utc=2026-05-10/connector_id=6/manifest.json",
          hash: "treeHashSame",
          size: 50,
        },
        "day_utc=2026-05-10/connector_id=7/manifest.json": {
          unit_type: "file",
          relative_path: "history/_index/observations_timeseries/day_utc=2026-05-10/connector_id=7/manifest.json",
          hash: "treeHashChanged-new",
          size: 50,
        },
      },
    },
  });
  const state = makeCheckpoint({
    indexTreeUnits: {
      observations_timeseries: {
        "day_utc=2026-05-10/connector_id=6/manifest.json": { hash: "treeHashSame", relative_path: "...", size: 50, copied_at: "" },
        "day_utc=2026-05-10/connector_id=7/manifest.json": { hash: "treeHashChanged-old", relative_path: "...", size: 50, copied_at: "" },
      },
    },
  });

  const candidates = planIndexTreeUnits(inventory, state);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].tree_key, "observations_timeseries");
  assert.equal(candidates[0].unit_key, "day_utc=2026-05-10/connector_id=7/manifest.json");
});

test("planIndexFiles and planIndexTreeUnits include v2 pollutant index keys", () => {
  const inventory = makeInventory({
    backupVersion: "v2",
    indexFiles: {
      observations_timeseries_v2_latest: {
        unit_type: "file",
        relative_path: "history/_index_v2/observations_timeseries_latest.json",
        hash: "v2LatestHash",
        size: 100,
      },
    },
    indexTreeUnits: {
      observations_timeseries_v2: {
        "day_utc=2026-05-10/connector_id=6/pollutant_code=pm25/manifest.json": {
          unit_type: "file",
          relative_path:
            "history/_index_v2/observations_timeseries/day_utc=2026-05-10/connector_id=6/pollutant_code=pm25/manifest.json",
          hash: "v2TreeHash",
          size: 50,
        },
      },
    },
  });
  const state = makeCheckpoint({});

  const fileCandidates = planIndexFiles(inventory, state, {
    indexFileKeys: indexFileKeysForBackupVersion("v2"),
  });
  const treeCandidates = planIndexTreeUnits(inventory, state, {
    indexTreeKeys: indexTreeKeysForBackupVersion("v2"),
  });

  assert.equal(fileCandidates.length, 1);
  assert.equal(fileCandidates[0].index_key, "observations_timeseries_v2_latest");
  assert.equal(treeCandidates.length, 1);
  assert.equal(treeCandidates[0].tree_key, "observations_timeseries_v2");
  assert.equal(
    treeCandidates[0].unit_key,
    "day_utc=2026-05-10/connector_id=6/pollutant_code=pm25/manifest.json",
  );
});


// ----- run manifest inventory/sync units -----

test("backup version selection resolves selected run manifest prefixes", () => {
  assert.equal(
    runManifestPrefixForBackupVersion(resolveBackupVersion({ UK_AQ_R2_HISTORY_BACKUP_VERSION: "v2" })),
    "history/v2/_ops/observations/runs",
  );
  assert.equal(
    runManifestPrefixForBackupVersion(resolveBackupVersion({ UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" })),
    "history/v2/_ops/observations/runs",
  );
  assert.equal(
    runManifestPrefixForBackupVersion(resolveBackupVersion({ UK_AQ_R2_HISTORY_BACKUP_VERSION: "v1", UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" })),
    "history/v1/_ops/observations/runs",
  );
});

test("run manifest inventory path filter accepts only run_id manifest files", () => {
  assert.equal(isRunManifestUnitPath("run_id=abc-123/run_manifest.json"), true);
  assert.equal(isRunManifestUnitPath("run_id=abc-123/other.json"), false);
  assert.equal(isRunManifestUnitPath("not_run_id=abc-123/run_manifest.json"), false);
  assert.equal(isRunManifestUnitPath("run_id=abc-123/nested/run_manifest.json"), false);
});

test("planRunManifestUnits: changed hash queued and same checkpoint hash skipped", () => {
  const unitKeySame = "run_id=same/run_manifest.json";
  const unitKeyChanged = "run_id=changed/run_manifest.json";
  const inventory = makeInventory({
    backupVersion: "v2",
    runManifestUnits: { observations: {
      [unitKeySame]: { unit_type: "file", relative_path: `history/v2/_ops/observations/runs/${unitKeySame}`, hash: "hash-same", size: 12 },
      [unitKeyChanged]: { unit_type: "file", relative_path: `history/v2/_ops/observations/runs/${unitKeyChanged}`, hash: "hash-new", size: 34 },
    } },
  });
  const state = makeCheckpoint({
    runManifestUnits: { observations: {
      [unitKeySame]: { relative_path: `history/v2/_ops/observations/runs/${unitKeySame}`, copied_at: "2026-06-01T00:00:00.000Z", hash: "hash-same", size: 12 },
      [unitKeyChanged]: { relative_path: `history/v2/_ops/observations/runs/${unitKeyChanged}`, copied_at: "2026-06-01T00:00:00.000Z", hash: "hash-old", size: 34 },
    } },
  });

  const candidates = planRunManifestUnits(inventory, state, { domains: ["observations"] });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].unit_key, unitKeyChanged);
});

test("selected v2 run manifests do not include v1 units", () => {
  const inventory = makeInventory({
    backupVersion: "v2",
    runManifestUnits: { observations: {
      "run_id=v2/run_manifest.json": { unit_type: "file", relative_path: "history/v2/_ops/observations/runs/run_id=v2/run_manifest.json", hash: "v2", size: 1 },
    } },
  });
  const candidates = planRunManifestUnits(inventory, makeCheckpoint({}), { domains: ["observations"] });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].inventory_entry.relative_path, /^history\/v2\//);
});


test("old checkpoints without run_manifest_units are upgraded in memory", () => {
  const state = sanitizeCheckpointState({
    version: 1,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    domains: { observations: { days: {} } },
  }, { backupVersion: "v2" });

  assert.deepEqual(state.run_manifest_units, { observations: { units: {} } });
});

test("run manifest checkpoint entries retain relative path, copied_at, hash, and size", () => {
  const state = sanitizeCheckpointState({
    run_manifest_units: { observations: { units: {
      "run_id=copied/run_manifest.json": {
        relative_path: "history/v2/_ops/observations/runs/run_id=copied/run_manifest.json",
        copied_at: "2026-06-02T00:00:00.000Z",
        hash: "abc123",
        size: 321,
      },
    } } },
  }, { backupVersion: "v2" });

  assert.deepEqual(state.run_manifest_units.observations.units["run_id=copied/run_manifest.json"], {
    relative_path: "history/v2/_ops/observations/runs/run_id=copied/run_manifest.json",
    copied_at: "2026-06-02T00:00:00.000Z",
    hash: "abc123",
    size: 321,
  });
});

test("selected v1 run manifests are supported as straightforward legacy file units", () => {
  const inventory = makeInventory({
    backupVersion: "v1",
    runManifestUnits: { observations: {
      "run_id=v1/run_manifest.json": { unit_type: "file", relative_path: "history/v1/_ops/observations/runs/run_id=v1/run_manifest.json", hash: "v1", size: 1 },
    } },
  });
  const candidates = planRunManifestUnits(inventory, makeCheckpoint({}), { domains: ["observations"] });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].inventory_entry.relative_path, /^history\/v1\//);
});

// ----- backup version selection -----

test("backup version defaults to v1 paths when write and backup vars are unset", () => {
  assert.equal(resolveBackupVersion({}), "v1");
  assert.equal(
    defaultInventoryRelPathForBackupVersion("v1"),
    "history/_index/backup_inventory_v1.json",
  );
  assert.equal(
    defaultStateRelPathForBackupVersion("v1"),
    "_ops/checkpoints/r2_history_backup_state_v1.json",
  );
  assert.deepEqual(domainNamesForBackupVersion("v1"), ["observations", "aqilevels", "core"]);
});

test("backup version follows write version when backup override is unset", () => {
  const env = { UK_AQ_R2_HISTORY_WRITE_VERSION: "v2" };
  assert.equal(resolveBackupVersion(env), "v2");
  assert.equal(
    defaultInventoryRelPathForBackupVersion(resolveBackupVersion(env)),
    "history/_index_v2/backup_inventory_v2.json",
  );
  assert.equal(
    defaultStateRelPathForBackupVersion(resolveBackupVersion(env)),
    "_ops/checkpoints/r2_history_backup_state_v2.json",
  );
  assert.deepEqual(
    domainNamesForBackupVersion("v2"),
    ["observations", "aqilevels", "aqilevels_debug", "core"],
  );
});

test("backup version override can pin v1 while write version is v2", () => {
  const env = {
    UK_AQ_R2_HISTORY_WRITE_VERSION: "v2",
    UK_AQ_R2_HISTORY_BACKUP_VERSION: "v1",
  };
  assert.equal(resolveBackupVersion(env), "v1");
  assert.equal(
    defaultInventoryRelPathForBackupVersion(resolveBackupVersion(env)),
    "history/_index/backup_inventory_v1.json",
  );
  assert.equal(
    defaultStateRelPathForBackupVersion(resolveBackupVersion(env)),
    "_ops/checkpoints/r2_history_backup_state_v1.json",
  );
});

test("v1 and v2 backup checkpoint paths are separate", () => {
  assert.notEqual(
    defaultStateRelPathForBackupVersion("v1"),
    defaultStateRelPathForBackupVersion("v2"),
  );
});

// ----- validateInventoryPayload -----

test("validateInventoryPayload: missing inventory throws actionable error in strict mode", () => {
  assert.throws(
    () =>
      validateInventoryPayload(
        { found: false, text: "" },
        { strict: true, targetPath: "uk_aq_r2:bucket/history/_index/backup_inventory_v1.json" },
      ),
    (err) => {
      assert.match(err.message, /Inventory not found at uk_aq_r2:bucket\/history\/_index\/backup_inventory_v1\.json/);
      assert.match(err.message, /re-run scripts\/backup_r2\/build_backup_inventory\.mjs/);
      return true;
    },
  );
});

test("validateInventoryPayload: missing inventory returns null in permissive mode", () => {
  const result = validateInventoryPayload(
    { found: false, text: "" },
    { strict: false, targetPath: "..." },
  );
  assert.equal(result, null);
});

test("validateInventoryPayload: empty inventory throws zero-bytes error in strict mode", () => {
  assert.throws(
    () =>
      validateInventoryPayload(
        { found: true, text: "" },
        { strict: true, targetPath: "remote:path" },
      ),
    /empty \(zero bytes\)/,
  );
});

test("validateInventoryPayload: wrong kind throws actionable error in strict mode", () => {
  assert.throws(
    () =>
      validateInventoryPayload(
        { found: true, text: JSON.stringify({ kind: "something-else", version: 1 }) },
        { strict: true, targetPath: "remote:path" },
      ),
    /unexpected kind/,
  );
});

test("validateInventoryPayload: wrong version throws actionable error in strict mode", () => {
  assert.throws(
    () =>
      validateInventoryPayload(
        { found: true, text: JSON.stringify({ kind: INVENTORY_KIND, version: 99 }) },
        { strict: true, targetPath: "remote:path" },
      ),
    /version=99/,
  );
});

test("validateInventoryPayload: returns parsed object for a valid inventory", () => {
  const payload = {
    kind: INVENTORY_KIND,
    version: INVENTORY_SCHEMA_VERSION,
    domains: { observations: { days: {} } },
  };
  const result = validateInventoryPayload(
    { found: true, text: JSON.stringify(payload) },
    { strict: true, targetPath: "remote:path" },
  );
  assert.equal(result.kind, INVENTORY_KIND);
  assert.equal(result.version, INVENTORY_SCHEMA_VERSION);
});
