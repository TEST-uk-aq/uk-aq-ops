// Minimal tests for the R2 history Dropbox backup inventory plumbing.
//
// Scope (per the plan):
// - planDays: unchanged day not queued
// - planDays: changed old day queued
// - planDays: new day queued
// - validateInventoryPayload: missing inventory fails loudly in strict mode

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildStaleParquetPrunePlan,
  dropboxReadListRetryOptions,
  isDropboxTransientReadListError,
  pruneStaleParquetForUnit,
  planDays,
  planIndexFiles,
  planIndexTreeUnits,
  planRunManifestUnits,
  sanitizeCheckpointState,
} from "../scripts/backup_r2/sync_history_to_dropbox.mjs";
import { rcloneCatMaybe } from "../scripts/backup_r2/lib/rclone.mjs";
import { indexTreeScanConfig, isRunManifestUnitPath } from "../scripts/backup_r2/build_backup_inventory.mjs";
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

function obsDayCheckpointEntryForVersion(dayUtc, hash, backupVersion = "v1") {
  const prefix = backupVersion === "v2"
    ? "history/v2/observations"
    : "history/v1/observations";
  return {
    manifest_key: `${prefix}/day_utc=${dayUtc}/manifest.json`,
    copied_at: "2026-05-14T00:00:00.000Z",
    manifest_hash: hash,
  };
}

const SYNC_ARGS = {
  domains: ["observations", "aqilevels", "core"],
  max_days_per_run: 0,
};

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-r2-backup-test-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeFakeRcloneFailurePlan(filePath, rules) {
  writeJson(filePath, { rules });
}

function makeFakeRcloneBin(tempDir) {
  const binPath = path.join(tempDir, "fake-rclone.mjs");
  writeText(binPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const [command, target, dest] = rawArgs;
if (process.env.FAKE_RCLONE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_RCLONE_LOG,
    JSON.stringify({ command, target, dest, args: rawArgs }) + "\\n",
    "utf8",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function injectPlannedFailure() {
  const planPath = process.env.FAKE_RCLONE_FAILURE_PLAN;
  if (!planPath || !fs.existsSync(planPath)) return;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const rules = Array.isArray(plan.rules) ? plan.rules : [];
  const rule = rules.find((candidate) => (
    Number(candidate.remaining || 0) > 0
    && (!candidate.command || candidate.command === command)
    && (!candidate.target_suffix || String(target || "").endsWith(candidate.target_suffix))
  ));
  if (!rule) return;
  rule.remaining = Number(rule.remaining) - 1;
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\\n", "utf8");
  fail(rule.message || "temporary failure");
}

function walkFiles(root, current = "", out = []) {
  const base = current ? path.join(root, current) : root;
  if (!fs.existsSync(base)) return out;
  const stat = fs.statSync(base);
  if (stat.isFile()) {
    out.push(current || path.basename(root));
    return out;
  }
  for (const name of fs.readdirSync(base).sort()) {
    walkFiles(root, current ? path.join(current, name) : name, out);
  }
  return out;
}

injectPlannedFailure();

if (command === "cat") {
  if (!fs.existsSync(target)) fail("object not found");
  if (fs.statSync(target).isDirectory()) fail("object not found");
  process.stdout.write(fs.readFileSync(target, "utf8"));
  process.exit(0);
}
if (command === "copy") {
  if (!fs.existsSync(target)) fail("source not found");
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(target, dest, { recursive: true, force: true });
  process.exit(0);
}
if (command === "copyto") {
  if (!fs.existsSync(target)) fail("source not found");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(target, dest);
  process.exit(0);
}
if (command === "deletefile") {
  if (!fs.existsSync(target)) fail("object not found");
  fs.unlinkSync(target);
  process.exit(0);
}
if (command === "lsjson") {
  if (!fs.existsSync(target)) {
    fail("directory not found");
  }
  const files = walkFiles(target).map((relativePath) => {
    const fullPath = path.join(target, relativePath);
    const stat = fs.statSync(fullPath);
    return {
      Path: relativePath.split(path.sep).join("/"),
      Name: path.basename(relativePath),
      Size: stat.size,
      IsDir: false
    };
  });
  process.stdout.write(JSON.stringify(files));
  process.exit(0);
}
fail("unsupported fake rclone command");
`);
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function runSyncCli({
  sourceRoot,
  destRoot,
  fakeRcloneBin,
  reportOut,
  extraArgs = [],
  backupVersion = "v1",
  fakeRcloneLog = "",
  fakeRcloneFailurePlan = "",
}) {
  return spawnSync(
    process.execPath,
    [
      "scripts/backup_r2/sync_history_to_dropbox.mjs",
      "--backup-version", backupVersion,
      "--source-root", sourceRoot,
      "--dest-root", destRoot,
      "--rclone-bin", fakeRcloneBin,
      "--report-out", reportOut,
      "--domain", "observations",
      ...extraArgs,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        UK_AQ_R2_HISTORY_VERSION: backupVersion,
        ...(fakeRcloneLog ? { FAKE_RCLONE_LOG: fakeRcloneLog } : {}),
        ...(fakeRcloneFailurePlan ? { FAKE_RCLONE_FAILURE_PLAN: fakeRcloneFailurePlan } : {}),
      },
    },
  );
}

function obsDayInventoryEntryForVersion(dayUtc, hash, backupVersion = "v1") {
  const prefix = backupVersion === "v2"
    ? "history/v2/observations"
    : "history/v1/observations";
  return {
    unit_type: "day_folder",
    relative_path: `${prefix}/day_utc=${dayUtc}`,
    manifest_relative_path: `${prefix}/day_utc=${dayUtc}/manifest.json`,
    manifest_hash: hash,
    manifest_size: 1234,
  };
}

function seedInventory(sourceRoot, { hash = "hash-new", days = ["2026-06-18"], backupVersion = "v1" } = {}) {
  const dayEntries = {};
  for (const dayUtc of days) {
    dayEntries[dayUtc] = obsDayInventoryEntryForVersion(dayUtc, hash, backupVersion);
  }
  const inventoryPath = backupVersion === "v2"
    ? "history/_index_v2/backup_inventory_v2.json"
    : "history/_index/backup_inventory_v1.json";
  writeJson(
    path.join(sourceRoot, inventoryPath),
    makeInventory({ backupVersion, days: { observations: dayEntries } }),
  );
}

function seedObservationDay(root, {
  dayUtc = "2026-06-18",
  manifestText = null,
  expectedPart = null,
  backupVersion = "v1",
} = {}) {
  const prefix = backupVersion === "v2"
    ? "history/v2/observations"
    : "history/v1/observations";
  const dayRoot = path.join(root, `${prefix}/day_utc=${dayUtc}`);
  const manifestPart = expectedPart
    || `${prefix}/day_utc=${dayUtc}/connector_id=1/part-00000.parquet`;
  const manifest = {
    day_utc: dayUtc,
    connector_id: null,
    parquet_object_keys: [manifestPart],
    files: [{ key: manifestPart, bytes: 1, row_count: 1 }],
  };
  writeText(
    path.join(dayRoot, "manifest.json"),
    manifestText ?? `${JSON.stringify(manifest, null, 2)}\n`,
  );
  writeText(path.join(dayRoot, "connector_id=1/part-00000.parquet"), "current");
  return dayRoot;
}

function seedDestinationWithStaleParquet(destRoot, { dayUtc = "2026-06-18", backupVersion = "v1" } = {}) {
  const prefix = backupVersion === "v2"
    ? "history/v2/observations"
    : "history/v1/observations";
  const dayRoot = path.join(destRoot, `${prefix}/day_utc=${dayUtc}`);
  seedObservationDay(destRoot, { dayUtc, backupVersion });
  writeText(path.join(dayRoot, "connector_id=1/part-00001.parquet"), "stale");
  writeText(path.join(dayRoot, "connector_id=1/notes.txt"), "keep");
  return dayRoot;
}

function writeCopyCheckpoint(destRoot, { dayUtc = "2026-06-18", hash = "hash-new", backupVersion = "v1" } = {}) {
  const relPath = backupVersion === "v2"
    ? "_ops/checkpoints/r2_history_backup_state_v2.json"
    : "_ops/checkpoints/r2_history_backup_state_v1.json";
  writeJson(
    path.join(destRoot, relPath),
    makeCheckpoint({
      days: { observations: { [dayUtc]: obsDayCheckpointEntryForVersion(dayUtc, hash, backupVersion) } },
    }),
  );
}

function writeV2PruneCheckpoint(destRoot, units) {
  writeJson(
    path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
    {
      version: 1,
      kind: "uk_aq_r2_history_backup_prune_state",
      backup_version: "v2",
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:00:00.000Z",
      units,
    },
  );
}

function readFakeRcloneLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withFakeRcloneEnvironment(envValues, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(envValues)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test("v2 backup inventory includes only stable timeseries bindings", () => {
  const keys = indexTreeKeysForBackupVersion("v2");
  assert.ok(keys.includes("timeseries_binding_v2"));
  assert.equal(keys.includes("timeseries_metadata_v2"), false);
});

test("v2 observation index inventory accepts canonical non-AQI property codes", () => {
  const args = { index_v2_prefix: "history/_index_v2" };
  const observations = indexTreeScanConfig("observations_timeseries_v2", args);
  const aqilevels = indexTreeScanConfig("aqilevels_hourly_data_timeseries_v2", args);
  for (const code of ["o3", "pm25index"]) {
    assert.equal(observations.unitPattern.test(`day_utc=2026-05-10/connector_id=6/pollutant_code=${code}/manifest.json`), true);
    assert.equal(aqilevels.unitPattern.test(`day_utc=2026-05-10/connector_id=6/pollutant_code=${code}/manifest.json`), false);
  }
});


// ----- run manifest inventory/sync units -----

test("backup version selection resolves selected run manifest prefixes", () => {
  assert.equal(
    runManifestPrefixForBackupVersion(resolveBackupVersion({ UK_AQ_R2_HISTORY_VERSION: "v2" })),
    "history/v2/_ops/observations/runs",
  );
  assert.equal(
    runManifestPrefixForBackupVersion(resolveBackupVersion({ UK_AQ_R2_HISTORY_VERSION: "v1" })),
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

// ----- manifest-guided stale Parquet pruning -----

test("buildStaleParquetPrunePlan deletes only destination Parquet absent from manifest", () => {
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: "history/v1/observations/day_utc=2026-06-18",
    manifest_entries: [{
      relative_path: "manifest.json",
      text: JSON.stringify({
        parquet_object_keys: [
          "history/v1/observations/day_utc=2026-06-18/connector_id=1/part-00000.parquet",
        ],
      }),
    }],
    actual_file_entries: [
      { Path: "connector_id=1/part-00000.parquet" },
      { Path: "connector_id=1/part-00001.parquet" },
      { Path: "connector_id=1/notes.txt" },
    ],
  });

  assert.equal(plan.manifest_referenced_parquet_count, 1);
  assert.equal(plan.actual_destination_parquet_count, 2);
  assert.deepEqual(plan.stale_relative_paths, ["connector_id=1/part-00001.parquet"]);
});

test("buildStaleParquetPrunePlan supports v2 nested pollutant manifests", () => {
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: "history/v2/observations/day_utc=2026-06-18",
    manifest_entries: [
      {
        relative_path: "manifest.json",
        text: JSON.stringify({
          child_manifests: [{
            connector_id: 1,
            manifest_key: "history/v2/observations/day_utc=2026-06-18/connector_id=1/manifest.json",
          }],
        }),
      },
      {
        relative_path: "connector_id=1/manifest.json",
        text: JSON.stringify({
          pollutant_manifests: [{
            pollutant_code: "no2",
            manifest_key: "history/v2/observations/day_utc=2026-06-18/connector_id=1/pollutant_code=no2/manifest.json",
          }],
        }),
      },
      {
        relative_path: "connector_id=1/pollutant_code=no2/manifest.json",
        text: JSON.stringify({
          parquet_object_keys: [
            "history/v2/observations/day_utc=2026-06-18/connector_id=1/pollutant_code=no2/part-00000.parquet",
          ],
        }),
      },
    ],
    actual_file_entries: [
      { Path: "connector_id=1/pollutant_code=no2/part-00000.parquet" },
      { Path: "connector_id=1/pollutant_code=no2/part-00001.parquet" },
    ],
  });

  assert.deepEqual(plan.stale_relative_paths, [
    "connector_id=1/pollutant_code=no2/part-00001.parquet",
  ]);
});

test("buildStaleParquetPrunePlan fails closed when manifest JSON is invalid", () => {
  assert.throws(
    () => buildStaleParquetPrunePlan({
      unit_relative_path: "history/v1/observations/day_utc=2026-06-18",
      manifest_entries: [{ relative_path: "manifest.json", text: "{bad json" }],
      actual_file_entries: [{ Path: "connector_id=1/part-00001.parquet" }],
    }),
    /Failed to parse manifest/,
  );
});

test("Dropbox read/list retry matcher accepts the production unexpected-error wording", () => {
  assert.equal(
    isDropboxTransientReadListError(
      new Error("2026/07/12 ERROR : error listing: unexpected error occurred"),
    ),
    true,
  );
  assert.equal(isDropboxTransientReadListError(new Error("invalid manifest JSON")), false);
});

test("Dropbox rclone cat transient read failure retries and prune succeeds", () => {
  const tempDir = makeTempDir();
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const failurePlan = path.join(tempDir, "failure-plan.json");
  const unitRelativePath = "history/v2/observations/day_utc=2026-06-18";
  const unitPath = seedDestinationWithStaleParquet(tempDir, { backupVersion: "v2" });
  const retryStats = { retry_count: 0, exhausted_count: 0, max_attempts_used: 1 };
  writeFakeRcloneFailurePlan(failurePlan, [{
    command: "cat",
    target_suffix: "/manifest.json",
    remaining: 1,
    message: "path/not_folder",
  }]);

  const summary = withFakeRcloneEnvironment(
    { FAKE_RCLONE_FAILURE_PLAN: failurePlan },
    () => pruneStaleParquetForUnit({
      rcloneBin: fakeRcloneBin,
      manifestRootPath: unitPath,
      destUnitPath: unitPath,
      unitRelativePath,
      readListRetryOptions: dropboxReadListRetryOptions({
        retryStats,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    }),
  );

  assert.equal(summary.prune_error_count, 0);
  assert.equal(summary.prune_deleted_count, 1);
  assert.equal(retryStats.retry_count, 1);
  assert.equal(retryStats.exhausted_count, 0);
  assert.equal(retryStats.max_attempts_used, 2);
});

test("Dropbox rclone lsjson production transient list failure retries and prune succeeds", () => {
  const tempDir = makeTempDir();
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const failurePlan = path.join(tempDir, "failure-plan.json");
  const unitRelativePath = "history/v2/observations/day_utc=2026-06-18";
  const unitPath = seedDestinationWithStaleParquet(tempDir, { backupVersion: "v2" });
  const retryStats = { retry_count: 0, exhausted_count: 0, max_attempts_used: 1 };
  writeFakeRcloneFailurePlan(failurePlan, [{
    command: "lsjson",
    target_suffix: "/day_utc=2026-06-18",
    remaining: 1,
    message: "error listing: unexpected error occurred",
  }]);

  const summary = withFakeRcloneEnvironment(
    { FAKE_RCLONE_FAILURE_PLAN: failurePlan },
    () => pruneStaleParquetForUnit({
      rcloneBin: fakeRcloneBin,
      manifestRootPath: unitPath,
      destUnitPath: unitPath,
      unitRelativePath,
      readListRetryOptions: dropboxReadListRetryOptions({
        retryStats,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    }),
  );

  assert.equal(summary.prune_deleted_count, 1);
  assert.equal(retryStats.retry_count, 1);
  assert.equal(retryStats.exhausted_count, 0);
  assert.equal(retryStats.max_attempts_used, 2);
});

test("Dropbox production transient list retry exhaustion fails closed without deleting", () => {
  const tempDir = makeTempDir();
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const fakeRcloneLog = path.join(tempDir, "rclone.log");
  const failurePlan = path.join(tempDir, "failure-plan.json");
  const unitRelativePath = "history/v2/observations/day_utc=2026-06-18";
  const unitPath = seedDestinationWithStaleParquet(tempDir, { backupVersion: "v2" });
  const stalePath = path.join(unitPath, "connector_id=1/part-00001.parquet");
  const retryStats = { retry_count: 0, exhausted_count: 0, max_attempts_used: 1 };
  writeFakeRcloneFailurePlan(failurePlan, [{
    command: "lsjson",
    target_suffix: "/day_utc=2026-06-18",
    remaining: 5,
    message: "error listing: unexpected error occurred",
  }]);

  assert.throws(
    () => withFakeRcloneEnvironment(
      {
        FAKE_RCLONE_FAILURE_PLAN: failurePlan,
        FAKE_RCLONE_LOG: fakeRcloneLog,
      },
      () => pruneStaleParquetForUnit({
        rcloneBin: fakeRcloneBin,
        manifestRootPath: unitPath,
        destUnitPath: unitPath,
        unitRelativePath,
        readListRetryOptions: dropboxReadListRetryOptions({
          retryStats,
          initialDelayMs: 0,
          maxDelayMs: 0,
        }),
      }),
    ),
    /unexpected error occurred/,
  );

  assert.equal(fs.existsSync(stalePath), true);
  assert.equal(retryStats.retry_count, 4);
  assert.equal(retryStats.exhausted_count, 1);
  assert.equal(retryStats.max_attempts_used, 5);
  assert.equal(readFakeRcloneLog(fakeRcloneLog).some((entry) => entry.command === "deletefile"), false);
});

test("prune reuses one recursive Dropbox listing when manifests and destination share a unit", () => {
  const tempDir = makeTempDir();
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const fakeRcloneLog = path.join(tempDir, "rclone.log");
  const unitRelativePath = "history/v2/observations/day_utc=2026-06-18";
  const unitPath = seedDestinationWithStaleParquet(tempDir, { backupVersion: "v2" });

  const summary = withFakeRcloneEnvironment(
    { FAKE_RCLONE_LOG: fakeRcloneLog },
    () => pruneStaleParquetForUnit({
      rcloneBin: fakeRcloneBin,
      manifestRootPath: unitPath,
      destUnitPath: unitPath,
      unitRelativePath,
    }),
  );

  assert.equal(summary.prune_deleted_count, 1);
  assert.equal(
    readFakeRcloneLog(fakeRcloneLog).filter((entry) => entry.command === "lsjson").length,
    1,
  );
});

test("ordinary rclone cat not-found remains missing without retry", () => {
  const tempDir = makeTempDir();
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const fakeRcloneLog = path.join(tempDir, "rclone.log");
  const retryStats = { retry_count: 0, exhausted_count: 0, max_attempts_used: 1 };

  const result = withFakeRcloneEnvironment(
    { FAKE_RCLONE_LOG: fakeRcloneLog },
    () => rcloneCatMaybe(
      fakeRcloneBin,
      path.join(tempDir, "missing.json"),
      dropboxReadListRetryOptions({
        retryStats,
        initialDelayMs: 0,
        maxDelayMs: 0,
      }),
    ),
  );

  assert.deepEqual(result, { found: false, text: "" });
  assert.equal(retryStats.retry_count, 0);
  assert.equal(readFakeRcloneLog(fakeRcloneLog).length, 1);
});

test("sync default prunes stale Parquet after copy and keeps non-Parquet files", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot);
  seedObservationDay(sourceRoot);
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/notes.txt")), true);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v1.json")), true);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.prune_deleted_count, 1);
  assert.deepEqual(report.prune.pruned_relative_paths, [
    "history/v1/observations/day_utc=2026-06-18/connector_id=1/part-00001.parquet",
  ]);
});

test("sync dry-run reports stale Parquet but does not delete or checkpoint", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot);
  seedObservationDay(sourceRoot);
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    extraArgs: ["--dry-run"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v1.json")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.prune_deleted_count, 0);
  assert.equal(report.prune.prune_dry_run_delete_count, 1);
});

test("sync default prunes unchanged inventory-listed units", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot, { hash: "same-hash" });
  seedObservationDay(sourceRoot);
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);
  writeJson(
    path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v1.json"),
    makeCheckpoint({
      days: { observations: { "2026-06-18": obsDayCheckpointEntry("2026-06-18", "same-hash") } },
    }),
  );

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.domains.observations.candidate_days, 0);
  assert.equal(report.prune.scope, "all");
  assert.equal(report.prune.prune_deleted_count, 1);
});

test("sync --prune-scope changed leaves unchanged inventory-listed units alone", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot, { hash: "same-hash" });
  seedObservationDay(sourceRoot);
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);
  writeJson(
    path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v1.json"),
    makeCheckpoint({
      days: { observations: { "2026-06-18": obsDayCheckpointEntry("2026-06-18", "same-hash") } },
    }),
  );

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    extraArgs: ["--prune-scope", "changed"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.domains.observations.candidate_days, 0);
  assert.equal(report.prune.scope, "changed");
  assert.equal(report.prune.attempted_units, 0);
});

test("sync default inventory-wide pruning is not limited by max-days-per-run and ignores non-inventory units", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot, { days: ["2026-06-18", "2026-06-19"] });
  seedObservationDay(sourceRoot, { dayUtc: "2026-06-18" });
  seedObservationDay(sourceRoot, { dayUtc: "2026-06-19" });
  const firstDestDayRoot = seedDestinationWithStaleParquet(destRoot, { dayUtc: "2026-06-18" });
  const secondDestDayRoot = seedDestinationWithStaleParquet(destRoot, { dayUtc: "2026-06-19" });
  const outsideInventoryDayRoot = seedDestinationWithStaleParquet(destRoot, { dayUtc: "2026-06-17" });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    extraArgs: ["--max-days-per-run", "1"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(firstDestDayRoot, "connector_id=1/part-00001.parquet")), false);
  assert.equal(fs.existsSync(path.join(secondDestDayRoot, "connector_id=1/part-00001.parquet")), false);
  assert.equal(fs.existsSync(path.join(outsideInventoryDayRoot, "connector_id=1/part-00001.parquet")), true);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.domains.observations.candidate_days, 1);
  assert.equal(report.domains.observations.skipped_by_limit, 1);
  assert.equal(report.prune.scope, "all");
  assert.equal(report.prune.prune_deleted_count, 2);
});

test("sync --no-prune-stale-parquet disables stale Parquet pruning", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot);
  seedObservationDay(sourceRoot);
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    extraArgs: ["--no-prune-stale-parquet"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.prune_skipped, true);
  assert.equal(report.prune.skipped_units, 1);
});

test("sync does not write checkpoint when manifest prune fails", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot);
  seedObservationDay(sourceRoot, { manifestText: "{bad json\n" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot);

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v1.json")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.prune_error_count, 1);
  assert.match(report.prune.units[0].error, /Failed to parse manifest/);
});

test("sync v2 missing prune checkpoint prunes inventory units and writes ok state", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut, backupVersion: "v2" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pruneStatePath = path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json");
  assert.equal(fs.existsSync(pruneStatePath), true);
  const pruneState = JSON.parse(fs.readFileSync(pruneStatePath, "utf8"));
  assert.equal(pruneState.backup_version, "v2");
  assert.equal(pruneState.units[unitPath].manifest_hash, "hash-v2");
  assert.equal(pruneState.units[unitPath].status, "ok");
  assert.equal(pruneState.units[unitPath].stale_deleted_count, 1);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.enabled, true);
  assert.equal(report.prune_checkpoint.existed, false);
  assert.equal(report.prune_checkpoint.entries_written, 1);
  assert.equal(report.prune.pruned_checkpoint_miss_count, 1);
});

test("sync v2 reports a recovered Dropbox manifest read retry and checkpoints the unit", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const failurePlan = path.join(tempDir, "failure-plan.json");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeFakeRcloneFailurePlan(failurePlan, [{
    command: "cat",
    target_suffix: `${unitPath}/manifest.json`,
    remaining: 1,
    message: "path/not_folder",
  }]);

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    fakeRcloneFailurePlan: failurePlan,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.read_list_retry_count, 1);
  assert.equal(report.prune.read_list_retry_exhausted_count, 0);
  assert.equal(report.prune.failed_units.length, 0);
  const pruneState = JSON.parse(
    fs.readFileSync(
      path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
      "utf8",
    ),
  );
  assert.equal(pruneState.units[unitPath].status, "ok");
});

test("sync v2 current prune checkpoint skips expensive prune listing", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const fakeRcloneLog = path.join(tempDir, "rclone.log");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeV2PruneCheckpoint(destRoot, {
    [unitPath]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-26T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 1,
      stale_deleted_count: 0,
    },
  });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    fakeRcloneLog,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  const logEntries = readFakeRcloneLog(fakeRcloneLog);
  assert.equal(
    logEntries.some((entry) => entry.command === "lsjson" && String(entry.target).endsWith(unitPath)),
    false,
  );
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.skipped_by_checkpoint, 1);
  assert.equal(report.prune_checkpoint.skipped_by_checkpoint, 1);
  assert.equal(report.prune_checkpoint.write_skipped_no_changes, true);
});

test("sync v2 stale prune checkpoint re-prunes and updates hash", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-new" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-new" });
  writeV2PruneCheckpoint(destRoot, {
    [unitPath]: {
      manifest_hash: "hash-old",
      status: "ok",
      pruned_at: "2026-06-25T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 1,
      stale_deleted_count: 0,
    },
  });

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut, backupVersion: "v2" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  const pruneState = JSON.parse(fs.readFileSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"), "utf8"));
  assert.equal(pruneState.units[unitPath].manifest_hash, "hash-new");
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.pruned_checkpoint_miss_count, 1);
  assert.equal(report.prune_checkpoint.entries_written, 1);
});

test("sync copied v2 unit prunes after copy even when prune checkpoint is current", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-new" });
  seedObservationDay(sourceRoot, { backupVersion: "v2" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-old" });
  writeV2PruneCheckpoint(destRoot, {
    [unitPath]: {
      manifest_hash: "hash-new",
      status: "ok",
      pruned_at: "2026-06-26T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 1,
      stale_deleted_count: 0,
    },
  });

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut, backupVersion: "v2" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.domains.observations.copied_days, 1);
  assert.equal(report.prune.pruned_after_copy_count, 1);
  assert.equal(report.prune_checkpoint.entries_written, 1);
});

test("sync v2 --force-prune-recheck ignores current prune checkpoint", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const unitPath = "history/v2/observations/day_utc=2026-06-18";
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeV2PruneCheckpoint(destRoot, {
    [unitPath]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-26T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 1,
      stale_deleted_count: 0,
    },
  });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--force-prune-recheck"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.force_recheck, true);
  assert.equal(report.prune_checkpoint.used_for_skip, false);
  assert.equal(report.prune.pruned_force_recheck_count, 1);
});

test("force/all prune continues after a failed unit and fails after auditing later units", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const firstDay = "2026-06-18";
  const secondDay = "2026-06-19";
  const firstUnit = `history/v2/observations/day_utc=${firstDay}`;
  const secondUnit = `history/v2/observations/day_utc=${secondDay}`;
  seedInventory(sourceRoot, {
    backupVersion: "v2",
    hash: "hash-v2",
    days: [firstDay, secondDay],
  });
  const firstDest = seedDestinationWithStaleParquet(destRoot, {
    backupVersion: "v2",
    dayUtc: firstDay,
  });
  const secondDest = seedDestinationWithStaleParquet(destRoot, {
    backupVersion: "v2",
    dayUtc: secondDay,
  });
  writeText(path.join(firstDest, "manifest.json"), "{bad json\n");
  writeJson(
    path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v2.json"),
    makeCheckpoint({
      days: {
        observations: {
          [firstDay]: obsDayCheckpointEntryForVersion(firstDay, "hash-v2", "v2"),
          [secondDay]: obsDayCheckpointEntryForVersion(secondDay, "hash-v2", "v2"),
        },
      },
    }),
  );

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--force-prune-recheck"],
  });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(firstDest, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(secondDest, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.prune.prune_error_count, 1);
  assert.equal(report.prune.continued_after_unit_failure, true);
  assert.equal(report.prune.failed_units.length, 1);
  assert.equal(report.prune.failed_units[0].unit_relative_path, firstUnit);
  assert.equal(report.prune.failed_units[0].retry_attempts, 1);
  assert.equal(report.prune.read_list_retry_count, 0);
  const pruneState = JSON.parse(
    fs.readFileSync(
      path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
      "utf8",
    ),
  );
  assert.equal(pruneState.units[firstUnit], undefined);
  assert.equal(pruneState.units[secondUnit].status, "ok");
});

test("sync v2 forced recheck removes a stale checkpoint entry for a failed unit", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const failurePlan = path.join(tempDir, "failure-plan.json");
  const firstDay = "2026-06-18";
  const secondDay = "2026-06-19";
  const firstUnit = `history/v2/observations/day_utc=${firstDay}`;
  const secondUnit = `history/v2/observations/day_utc=${secondDay}`;

  seedInventory(sourceRoot, {
    backupVersion: "v2",
    hash: "hash-v2",
    days: [firstDay, secondDay],
  });
  seedDestinationWithStaleParquet(destRoot, {
    backupVersion: "v2",
    dayUtc: firstDay,
  });
  seedDestinationWithStaleParquet(destRoot, {
    backupVersion: "v2",
    dayUtc: secondDay,
  });
  writeJson(
    path.join(destRoot, "_ops/checkpoints/r2_history_backup_state_v2.json"),
    makeCheckpoint({
      days: {
        observations: {
          [firstDay]: obsDayCheckpointEntryForVersion(firstDay, "hash-v2", "v2"),
          [secondDay]: obsDayCheckpointEntryForVersion(secondDay, "hash-v2", "v2"),
        },
      },
    }),
  );
  writeV2PruneCheckpoint(destRoot, {
    [firstUnit]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-25T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 2,
      stale_deleted_count: 1,
    },
    [secondUnit]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-25T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 2,
      stale_deleted_count: 1,
    },
  });
  writeFakeRcloneFailurePlan(failurePlan, [{
    command: "lsjson",
    target_suffix: firstUnit,
    remaining: 1,
    message: "temporary prune audit failure",
  }]);

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--force-prune-recheck"],
    fakeRcloneFailurePlan: failurePlan,
  });

  assert.notEqual(result.status, 0);
  const pruneState = JSON.parse(
    fs.readFileSync(
      path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
      "utf8",
    ),
  );
  assert.equal(pruneState.units[firstUnit], undefined);
  assert.equal(pruneState.units[secondUnit].status, "ok");
  assert.equal(fs.existsSync(path.join(destRoot, firstUnit, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(destRoot, secondUnit, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.failed_units.length, 1);
  assert.equal(report.prune.failed_units[0].unit_relative_path, firstUnit);
});

test("sync v2 forced recheck persists a checkpoint invalidation without successful units", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const failedDay = "2026-06-18";
  const failedUnit = `history/v2/observations/day_utc=${failedDay}`;
  const unrelatedUnit = "history/v2/observations/day_utc=2026-06-19";
  const unrelatedEntry = {
    manifest_hash: "unrelated-hash",
    status: "ok",
    pruned_at: "2026-06-25T00:00:00.000Z",
    manifest_count: 1,
    manifest_referenced_parquet_count: 1,
    actual_destination_parquet_count: 1,
    stale_deleted_count: 0,
  };

  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2", days: [failedDay] });
  const failedDest = seedDestinationWithStaleParquet(destRoot, {
    backupVersion: "v2",
    dayUtc: failedDay,
  });
  writeText(path.join(failedDest, "manifest.json"), "{bad json\n");
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", dayUtc: failedDay, hash: "hash-v2" });
  writeV2PruneCheckpoint(destRoot, {
    [failedUnit]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-25T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 2,
      stale_deleted_count: 1,
    },
    [unrelatedUnit]: unrelatedEntry,
  });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--force-prune-recheck"],
  });

  assert.notEqual(result.status, 0);
  const pruneState = JSON.parse(
    fs.readFileSync(
      path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
      "utf8",
    ),
  );
  assert.equal(pruneState.units[failedUnit], undefined);
  assert.deepEqual(pruneState.units[unrelatedUnit], unrelatedEntry);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.prune.failed_units[0].unit_relative_path, failedUnit);
  assert.equal(report.prune_checkpoint.entries_written, 0);
});

test("sync v2 forced dry-run failure does not modify the prune checkpoint", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const dayUtc = "2026-06-18";
  const unitPath = `history/v2/observations/day_utc=${dayUtc}`;
  const checkpoint = {
    [unitPath]: {
      manifest_hash: "hash-v2",
      status: "ok",
      pruned_at: "2026-06-25T00:00:00.000Z",
      manifest_count: 1,
      manifest_referenced_parquet_count: 1,
      actual_destination_parquet_count: 2,
      stale_deleted_count: 1,
    },
  };

  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2", days: [dayUtc] });
  const destDay = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2", dayUtc });
  writeText(path.join(destDay, "manifest.json"), "{bad json\n");
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", dayUtc, hash: "hash-v2" });
  writeV2PruneCheckpoint(destRoot, checkpoint);
  const checkpointPath = path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json");
  const checkpointBefore = fs.readFileSync(checkpointPath, "utf8");

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--force-prune-recheck", "--dry-run"],
  });

  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(checkpointPath, "utf8"), checkpointBefore);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.write_skipped_dry_run, true);
});

test("sync v2 ordinary prune failure preserves its existing checkpoint entry", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const dayUtc = "2026-06-18";
  const unitPath = `history/v2/observations/day_utc=${dayUtc}`;
  const checkpointEntry = {
    manifest_hash: "old-hash",
    status: "ok",
    pruned_at: "2026-06-25T00:00:00.000Z",
    manifest_count: 1,
    manifest_referenced_parquet_count: 1,
    actual_destination_parquet_count: 2,
    stale_deleted_count: 1,
  };

  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2", days: [dayUtc] });
  const destDay = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2", dayUtc });
  writeText(path.join(destDay, "manifest.json"), "{bad json\n");
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", dayUtc, hash: "hash-v2" });
  writeV2PruneCheckpoint(destRoot, { [unitPath]: checkpointEntry });

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut, backupVersion: "v2" });

  assert.notEqual(result.status, 0);
  const pruneState = JSON.parse(
    fs.readFileSync(
      path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"),
      "utf8",
    ),
  );
  assert.deepEqual(pruneState.units[unitPath], checkpointEntry);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.write_skipped_no_changes, true);
});

test("sync v2 dry-run does not delete or write prune checkpoint but reports planned update", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--dry-run"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.prune_dry_run_delete_count, 1);
  assert.equal(report.prune_checkpoint.write_skipped_dry_run, true);
  assert.equal(report.prune_checkpoint.planned_entries_written, 1);
});

test("sync v2 --prune-scope changed ignores unchanged units even with missing prune checkpoint", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });

  const result = runSyncCli({
    sourceRoot,
    destRoot,
    fakeRcloneBin,
    reportOut,
    backupVersion: "v2",
    extraArgs: ["--prune-scope", "changed"],
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), true);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune.scope, "changed");
  assert.equal(report.prune.attempted_units, 0);
  assert.equal(report.prune_checkpoint.write_skipped_no_changes, true);
});

test("sync v1 does not create or require prune checkpoint", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot, { hash: "hash-v1" });
  seedDestinationWithStaleParquet(destRoot);
  writeCopyCheckpoint(destRoot, { hash: "hash-v1" });

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json")), false);
  assert.equal(fs.existsSync(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v1.json")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.enabled, false);
});

test("sync v2 invalid prune checkpoint warns and does not skip pruning", () => {
  const tempDir = makeTempDir();
  const sourceRoot = path.join(tempDir, "source");
  const destRoot = path.join(tempDir, "dest");
  const fakeRcloneBin = makeFakeRcloneBin(tempDir);
  const reportOut = path.join(tempDir, "report.json");
  seedInventory(sourceRoot, { backupVersion: "v2", hash: "hash-v2" });
  const destDayRoot = seedDestinationWithStaleParquet(destRoot, { backupVersion: "v2" });
  writeCopyCheckpoint(destRoot, { backupVersion: "v2", hash: "hash-v2" });
  writeText(path.join(destRoot, "_ops/checkpoints/r2_history_backup_prune_state_v2.json"), "{bad json\n");

  const result = runSyncCli({ sourceRoot, destRoot, fakeRcloneBin, reportOut, backupVersion: "v2" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(destDayRoot, "connector_id=1/part-00001.parquet")), false);
  const report = JSON.parse(fs.readFileSync(reportOut, "utf8"));
  assert.equal(report.prune_checkpoint.existed, true);
  assert.equal(report.prune_checkpoint.loaded, false);
  assert.equal(report.prune_checkpoint.used_for_skip, false);
  assert.match(report.prune_checkpoint.warnings[0], /Ignoring invalid v2 prune checkpoint/);
});

// ----- backup version selection -----

test("backup version rejects missing canonical history version", () => {
  assert.throws(
    () => resolveBackupVersion({}),
    /Missing UK_AQ_R2_HISTORY_VERSION/,
  );
});

test("backup version selects v1 paths from canonical v1 history version", () => {
  assert.equal(resolveBackupVersion({ UK_AQ_R2_HISTORY_VERSION: "v1" }), "v1");
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

test("backup version follows canonical history version for v2 paths", () => {
  const env = { UK_AQ_R2_HISTORY_VERSION: "v2" };
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

test("backup version rejects deprecated split backup and write vars", () => {
  assert.throws(
    () => resolveBackupVersion({
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_WRITE_VERSION: "v2",
    }),
    /UK_AQ_R2_HISTORY_WRITE_VERSION/,
  );
  assert.throws(
    () => resolveBackupVersion({
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_BACKUP_VERSION: "v1",
    }),
    /UK_AQ_R2_HISTORY_BACKUP_VERSION/,
  );
});

test("v1 and v2 backup checkpoint paths are separate", () => {
  assert.notEqual(
    defaultStateRelPathForBackupVersion("v1"),
    defaultStateRelPathForBackupVersion("v2"),
  );
});

test("v2 checkpoint sanitizer rejects copied v1 checkpoint state", () => {
  assert.throws(
    () =>
      sanitizeCheckpointState(
        {
          backup_version: "v1",
          domains: {
            observations: {
              days: {
                "2025-01-01": {
                  manifest_key: "history/v1/observations/day_utc=2025-01-01/manifest.json",
                  copied_at: "2026-07-08T00:00:00.000Z",
                  manifest_hash: "hash",
                },
              },
            },
          },
        },
        { backupVersion: "v2" },
      ),
    /backup_version=v1 does not match selected backup version v2/,
  );
});

test("v2 checkpoint sanitizer rejects v1 manifest keys rewritten into the wrong domain", () => {
  assert.throws(
    () =>
      sanitizeCheckpointState(
        {
          backup_version: "v2",
          domains: {
            aqilevels: {
              days: {
                "2025-01-01": {
                  manifest_key: "history/v2/aqilevels/day_utc=2025-01-01/manifest.json",
                  copied_at: "2026-07-08T00:00:00.000Z",
                  manifest_hash: "hash",
                },
              },
            },
          },
        },
        { backupVersion: "v2" },
      ),
    /does not start with history\/v2\/aqilevels\/hourly\/data\/day_utc=/,
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
