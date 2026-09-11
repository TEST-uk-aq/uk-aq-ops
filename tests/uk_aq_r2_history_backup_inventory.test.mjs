import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  buildCoreInventoryShard,
  syncCoreToDropbox,
  validateCoreInventoryShard,
  validateCoreState,
} from "../scripts/backup_r2/lib/hierarchical_core_backup_v2.mjs";
import {
  assertSelectedBackupInventory,
  sha256Hex,
  stableJson,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  buildTimeseriesBindingSourceRootManifest,
  timeseriesBindingSourceRootKey,
} from "../scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs";
import {
  buildStaleParquetPrunePlan,
} from "../scripts/backup_r2/lib/stale_parquet_prune.mjs";
import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsYearManifest,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const h = (char) => char.repeat(64);

function runHelp(relativePath) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, relativePath), "--help"],
    { encoding: "utf8" },
  );
}

function writeJsonFixture(root, relativePath, payload) {
  const filename = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(payload), "utf8");
}

function createFakeRclone(directory) {
  const filename = path.join(directory, "fake-rclone.mjs");
  writeFileSync(filename, [
    "#!/usr/bin/env node",
    "import { createHash } from \"node:crypto\";",
    "import fs from \"node:fs\";",
    "import path from \"node:path\";",
    "",
    "const [command, ...args] = process.argv.slice(2);",
    "const failNotFound = (target) => {",
    "  process.stderr.write(\"not found: \" + target + \"\\n\");",
    "  process.exit(1);",
    "};",
    "const entryFor = (filename, relativePath) => {",
    "  const stat = fs.statSync(filename);",
    "  return {",
    "    Name: path.basename(filename),",
    "    Path: relativePath,",
    "    Size: stat.size,",
    "    ModTime: stat.mtime.toISOString(),",
    "    Hashes: {",
    "      md5: createHash(\"md5\").update(fs.readFileSync(filename)).digest(\"hex\"),",
    "    },",
    "  };",
    "};",
    "const walk = (root, current = root, output = []) => {",
    "  for (const item of fs.readdirSync(current, { withFileTypes: true })) {",
    "    const filename = path.join(current, item.name);",
    "    if (item.isDirectory()) walk(root, filename, output);",
    "    else if (item.isFile()) {",
    "      output.push(entryFor(filename, path.relative(root, filename).split(path.sep).join(\"/\")));",
    "    }",
    "  }",
    "  return output;",
    "};",
    "",
    "if (command === \"cat\") {",
    "  if (!fs.existsSync(args[0]) || !fs.statSync(args[0]).isFile()) failNotFound(args[0]);",
    "  process.stdout.write(fs.readFileSync(args[0]));",
    "} else if (command === \"copyto\") {",
    "  fs.mkdirSync(path.dirname(args[1]), { recursive: true });",
    "  fs.copyFileSync(args[0], args[1]);",
    "} else if (command === \"lsjson\") {",
    "  const target = args[0];",
    "  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {",
    "    process.stdout.write(\"[]\");",
    "  } else if (args.includes(\"--recursive\")) {",
    "    process.stdout.write(JSON.stringify(walk(target)));",
    "  } else {",
    "    const entries = fs.readdirSync(target, { withFileTypes: true })",
    "      .filter((item) => item.isFile())",
    "      .map((item) => entryFor(path.join(target, item.name), item.name));",
    "    process.stdout.write(JSON.stringify(entries));",
    "  }",
    "} else {",
    "  process.stderr.write(\"unsupported fake rclone command: \" + String(command) + \"\\n\");",
    "  process.exit(2);",
    "}",
    "",
  ].join("\n"), "utf8");
  chmodSync(filename, 0o755);
  return filename;
}

function createInventorySourceFixture(sourceRoot, generation) {
  const dayUtc = "2026-09-10";
  const dayManifestHash = h("d");
  const dayManifestKey =
    generation.observations_prefix + "/day_utc=" + dayUtc + "/manifest.json";
  const month = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: generation.observations_prefix,
    year: 2026,
    month: 9,
    dayManifests: [{
      day_utc: dayUtc,
      manifest_key: dayManifestKey,
      manifest_hash: dayManifestHash,
    }],
  });
  const year = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: generation.observations_prefix,
    year: 2026,
    monthManifests: [month],
  });
  const root = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: generation.observations_prefix,
    yearManifests: [year],
  });

  writeJsonFixture(sourceRoot, dayManifestKey, {
    manifest_hash: dayManifestHash,
  });
  writeJsonFixture(sourceRoot, year.children[0].manifest_key, month);
  writeJsonFixture(sourceRoot, root.children[0].manifest_key, year);
  writeJsonFixture(sourceRoot, generation.observations_root_key, root);
  writeJsonFixture(sourceRoot, generation.observations_timeseries_latest_key, {
    generation: generation.version,
  });
  writeJsonFixture(
    sourceRoot,
    timeseriesBindingSourceRootKey(generation.timeseries_binding_index_prefix),
    buildTimeseriesBindingSourceRootManifest({
      bindingPrefix: generation.timeseries_binding_index_prefix,
      ranges: [],
    }),
  );
}

function lockedBackupEnvironment(version) {
  const env = {
    ...process.env,
    UK_AQ_R2_HISTORY_VERSION: version,
  };
  for (const name of [
    "UK_AQ_R2_HISTORY_READ_VERSION",
    "UK_AQ_R2_HISTORY_WRITE_VERSION",
    "UK_AQ_R2_HISTORY_BACKUP_VERSION",
    "UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX",
    "UK_AQ_R2_HISTORY_V2_RUNS_PREFIX",
    "UK_AQ_R2_HISTORY_TIMESERIES_BINDING_V2_PREFIX",
    "UK_AQ_R2_HISTORY_INDEX_V2_PREFIX",
    "UK_AQ_R2_HISTORY_V2_CORE_PREFIX",
    "UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX",
  ]) delete env[name];
  const identity = observationsGlobalOperationLockIdentity();
  return {
    ...env,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: "r2_history_dropbox_backup",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: "inventory-regression:" + version,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]:
      identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "inventory-regression-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

test("production backup entrypoints load under their established filenames", () => {
  const builder = runHelp("scripts/backup_r2/build_backup_inventory.mjs");
  assert.equal(builder.status, 0, builder.stderr);
  assert.match(builder.stdout, /build_backup_inventory\.mjs/);
  assert.match(builder.stdout, /--core-prefix/);
  assert.match(builder.stdout, /--timeseries-binding-prefix/);
  assert.match(builder.stdout, /--history-index-version <v2\|v3>/);
  assert.doesNotMatch(builder.stdout, /--legacy-inventory-key/);

  const sync = runHelp("scripts/backup_r2/sync_history_to_dropbox.mjs");
  assert.equal(sync.status, 0, sync.stderr);
  assert.match(sync.stdout, /sync_history_to_dropbox\.mjs/);
  assert.match(sync.stdout, /--force-prune-recheck/);
  assert.match(sync.stdout, /--state-root-prefix/);
  assert.doesNotMatch(sync.stdout, /--legacy-state-key/);
});

for (const version of ["v2", "v3"]) {
  test(
    "inventory builder publishes a selected " + version + " root with explicit generation identity",
    (t) => {
      const temporaryRoot = mkdtempSync(
        path.join(os.tmpdir(), "uk-aq-backup-inventory-generation-"),
      );
      t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
      const sourceRoot = path.join(temporaryRoot, "source");
      const reportPath = path.join(temporaryRoot, "report.json");
      mkdirSync(sourceRoot, { recursive: true });
      const fakeRclone = createFakeRclone(temporaryRoot);
      const generation = getObservationHistoryGeneration(version);
      createInventorySourceFixture(sourceRoot, generation);

      const builderArgs = [
        path.join(REPO_ROOT, "scripts/backup_r2/build_backup_inventory.mjs"),
        "--source-root", sourceRoot,
        "--rclone-bin", fakeRclone,
        "--report-out", reportPath,
      ];
      const builderOptions = {
        cwd: REPO_ROOT,
        env: lockedBackupEnvironment(version),
        encoding: "utf8",
      };
      const result = spawnSync(process.execPath, builderArgs, builderOptions);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(
        result.stderr + result.stdout,
        /generation is not defined/,
      );
      const inventoryRootPath = path.join(
        sourceRoot,
        ...generation.backup_inventory_prefix.split("/"),
        "root.json",
      );
      const inventoryRoot = JSON.parse(readFileSync(inventoryRootPath, "utf8"));
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(inventoryRoot.observation_generation, version);
      assert.equal(report.inventory_root_written, true);
      assert.doesNotThrow(
        () => assertSelectedBackupInventory(generation, inventoryRoot),
      );
      assert.throws(
        () => assertSelectedBackupInventory(
          getObservationHistoryGeneration(version === "v2" ? "v3" : "v2"),
          inventoryRoot,
        ),
        /does not describe the selected complete generation/,
      );

      const repeatResult = spawnSync(
        process.execPath,
        builderArgs,
        builderOptions,
      );
      assert.equal(
        repeatResult.status,
        0,
        repeatResult.stderr || repeatResult.stdout,
      );
      assert.doesNotMatch(
        repeatResult.stderr + repeatResult.stdout,
        /generation is not defined/,
      );
      assert.equal(
        JSON.parse(readFileSync(reportPath, "utf8")).inventory_root_written,
        false,
      );
    },
  );
}

test("backup workflow passes explicit complete observation generation without fallback", () => {
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/uk_aq_r2_history_dropbox_backup.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /UK_AQ_R2_HISTORY_VERSION: \$\{\{ vars\.UK_AQ_R2_HISTORY_VERSION \|\| '' \}\}/,
  );
  assert.match(workflow, /case "\$\{UK_AQ_R2_HISTORY_VERSION\}" in/);
  assert.match(workflow, /v2\|v3\)/);
  assert.doesNotMatch(workflow, /UK_AQ_R2_HISTORY_INDEX_VERSION/);
  assert.doesNotMatch(workflow, /--history-index-version/);
  assert.doesNotMatch(workflow, /--latest-timeseries-key/);
});

test("backup workflow defaults timeseries binding transport to pack with rollback choice", () => {
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/uk_aq_r2_history_dropbox_backup.yml"),
    "utf8",
  );
  const inputStart = workflow.indexOf("      timeseries_binding_backup_mode:");
  const inputEnd = workflow.indexOf("\n\npermissions:", inputStart);
  assert.ok(inputStart >= 0 && inputEnd > inputStart, "binding mode input block must exist");
  const inputBlock = workflow.slice(inputStart, inputEnd);

  assert.match(inputBlock, /default: "pack"/);
  assert.match(inputBlock, /options:\n\s+- individual\n\s+- pack/);
  assert.match(
    workflow,
    /INPUT_TIMESERIES_BINDING_BACKUP_MODE: \$\{\{ github\.event\.inputs\.timeseries_binding_backup_mode \|\| 'pack' \}\}/,
  );
  assert.match(
    workflow,
    /selected_mode="\$\{INPUT_TIMESERIES_BINDING_BACKUP_MODE:-pack\}"/,
  );
  assert.match(
    workflow,
    /if \[ "\$\{selected_mode\}" = "pack" \]; then\s+cmd\+=\(--allow-experimental-pack-only\)/,
  );
  assert.doesNotMatch(workflow, /--timeseries-binding-packs-only/);
});

test("core inventory identity is deterministic and non-range based", () => {
  const shardA = buildCoreInventoryShard("history/v2/core", [
    {
      day_utc: "2026-08-07",
      manifest_hash: h("a"),
      manifest_size: 123,
      r2_md5: "md5-a",
      r2_modtime: "2026-08-07T10:00:00Z",
    },
    {
      day_utc: "2026-08-06",
      manifest_hash: h("b"),
      manifest_size: 122,
      r2_md5: "md5-b",
      r2_modtime: "2026-08-06T10:00:00Z",
    },
  ]);
  const shardB = buildCoreInventoryShard("history/v2/core", [...shardA.days].reverse());

  assert.equal(shardA.source_hash, shardB.source_hash);
  assert.equal(shardA.days[0].day_utc, "2026-08-06");
  assert.equal(shardA.days[1].day_utc, "2026-08-07");
  assert.deepEqual(validateCoreInventoryShard(shardA), shardA);
  assert.equal("ranges" in shardA, false);
});

test("core state accepts compact processed identity", () => {
  const state = validateCoreState({
    schema_version: 1,
    kind: "uk_aq_r2_history_backup_state_core",
    backup_version: "v2",
    processed_source_hash: h("c"),
    days: [{
      day_utc: "2026-08-07",
      manifest_hash: h("d"),
      copied_at: "2026-08-07T12:00:00.000Z",
    }],
  });
  assert.equal(state.processed_source_hash, h("c"));
  assert.equal(state.days.length, 1);
});

test("fresh core state copies and checkpoints every current unit", () => {
  const inventory = buildCoreInventoryShard("history/v2/core", [{
    day_utc: "2026-08-07",
    manifest_hash: h("a"),
    manifest_size: 123,
    r2_md5: "md5-a",
    r2_modtime: "2026-08-07T10:00:00Z",
  }]);
  const inventoryShardKey =
    "history/_index_v2/backup_inventory_v2/global/core.json";
  const stateRoot = {};
  const writes = [];
  let copyCalls = 0;

  const result = syncCoreToDropbox({
    inventoryRoot: {
      core: {
        source_prefix: "history/v2/core",
        inventory_shard_key: inventoryShardKey,
        inventory_shard_hash: sha256Hex(stableJson(inventory)),
        source_hash: inventory.source_hash,
        unit_count: 1,
      },
    },
    stateRoot,
    stateRootPrefix: "_ops/checkpoints/r2_history_backup_state_v2",
    dryRun: false,
    checkpointBatchUnits: 10,
    checkpointFlushSeconds: 60,
    readInventoryJson: (key) => {
      assert.equal(key, inventoryShardKey);
      return inventory;
    },
    readStateJsonMaybe: () => null,
    writeStateJson: (key, payload) => {
      writes.push({ key, payload });
      return { written: true, hash: h("f") };
    },
    copyAndVerifyDay: () => {
      copyCalls += 1;
      return { source_hash: h("a"), verified: true, dry_run: false };
    },
  });

  assert.equal(copyCalls, 1);
  assert.equal(result.report.candidates, 1);
  assert.equal(result.report.copied, 1);
  assert.equal(result.report.state_shards_written, 1);
  assert.equal(result.report.checkpoint_flush_count, 1);
  assert.equal(result.report.complete, true);
  assert.equal(result.state_root_dirty, true);
  assert.equal(writes.length, 1);
  assert.equal(
    writes[0].key,
    "_ops/checkpoints/r2_history_backup_state_v2/global/core.json",
  );
  assert.equal(
    writes[0].payload.processed_source_hash,
    inventory.source_hash,
  );
  assert.equal(stateRoot.core.state_shard_hash, h("f"));
});

test("manifest-guided prune plan only marks unreferenced Parquet stale", () => {
  const plan = buildStaleParquetPrunePlan({
    unit_relative_path: "history/v2/observations/day_utc=2026-08-07",
    manifest_entries: [{
      relative_path: "manifest.json",
      text: JSON.stringify({
        parquet_object_keys: [
          "history/v2/observations/day_utc=2026-08-07/connector_id=1/current.parquet",
        ],
      }),
    }],
    actual_file_entries: [
      { Path: "connector_id=1/current.parquet" },
      { Path: "connector_id=1/stale.parquet" },
    ],
  });

  assert.deepEqual(plan.stale_relative_paths, ["connector_id=1/stale.parquet"]);
});
