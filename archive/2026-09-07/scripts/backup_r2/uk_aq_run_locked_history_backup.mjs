#!/usr/bin/env node

import { resolveObservationHistoryGeneration, assertObservationHistoryGenerationPrefixes } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  resolveObservationsTimeseriesLatestPath,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  assertExperimentalPackOnlyDestination,
  normalizeTimeseriesBindingBackupMode,
} from "./lib/timeseries_binding_pack_inventory_v1.mjs";
import {
  DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
} from "./lib/timeseries_binding_backup_pack_v1.mjs";

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseLockedHistoryBackupArgs(argv) {
  const args = {
    sourceRoot: null,
    destRoot: null,
    observationsPrefix: null,
    runsPrefix: null,
    corePrefix: null,
    timeseriesBindingPrefix: null,
    timeseriesBindingBackupMode: "individual",
    timeseriesBindingPackPrefix: DEFAULT_TIMESERIES_BINDING_BACKUP_PACK_PREFIX,
    historyIndexVersion: null,
    inventoryRootPrefix: null,
    stateRootPrefix: null,
    maxDaysPerRun: "0",
    checkpointBatchUnits: "10",
    checkpointFlushSeconds: "60",
    inventoryReportOut: null,
    backupReportOut: null,
    dryRun: false,
    forcePruneRecheck: false,
    allowExperimentalPackOnly: false,
    timeseriesBindingPacksOnly: false,
    packPublisherReportOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--force-prune-recheck") args.forcePruneRecheck = true;
    else if (flag === "--allow-experimental-pack-only") {
      args.allowExperimentalPackOnly = true;
    } else if (flag === "--timeseries-binding-packs-only") {
      args.timeseriesBindingPacksOnly = true;
    }
    else {
      const value = requireValue(argv, index, flag);
      index += 1;
      if (flag === "--source-root") args.sourceRoot = value;
      else if (flag === "--dest-root") args.destRoot = value;
      else if (flag === "--observations-prefix") args.observationsPrefix = value;
      else if (flag === "--runs-prefix") args.runsPrefix = value;
      else if (flag === "--core-prefix") args.corePrefix = value;
      else if (flag === "--timeseries-binding-prefix") args.timeseriesBindingPrefix = value;
      else if (flag === "--timeseries-binding-backup-mode") {
        args.timeseriesBindingBackupMode = normalizeTimeseriesBindingBackupMode(value);
      } else if (flag === "--timeseries-binding-pack-prefix") {
        args.timeseriesBindingPackPrefix = value;
      }
      else if (flag === "--history-index-version") args.historyIndexVersion = value;
      else if (flag === "--inventory-root-prefix") args.inventoryRootPrefix = value;
      else if (flag === "--state-root-prefix") args.stateRootPrefix = value;
      else if (flag === "--max-days-per-run") args.maxDaysPerRun = value;
      else if (flag === "--checkpoint-batch-units") args.checkpointBatchUnits = value;
      else if (flag === "--checkpoint-flush-seconds") args.checkpointFlushSeconds = value;
      else if (flag === "--inventory-report-out") args.inventoryReportOut = value;
      else if (flag === "--backup-report-out") args.backupReportOut = value;
      else if (flag === "--pack-publisher-report-out") {
        args.packPublisherReportOut = value;
      }
      else throw new Error(`Unknown argument: ${flag}`);
    }
  }
  for (const [flag, value] of [
    ["--source-root", args.sourceRoot],
    ["--dest-root", args.destRoot],
    ["--core-prefix", args.corePrefix],
    ["--inventory-root-prefix", args.inventoryRootPrefix],
    ["--state-root-prefix", args.stateRootPrefix],
    ["--inventory-report-out", args.inventoryReportOut],
    ["--backup-report-out", args.backupReportOut],
  ]) {
    if (!value) throw new Error(`${flag} is required`);
  }
  for (const [flag, value] of [
    ["--max-days-per-run", args.maxDaysPerRun],
    ["--checkpoint-batch-units", args.checkpointBatchUnits],
    ["--checkpoint-flush-seconds", args.checkpointFlushSeconds],
  ]) {
    if (!/^\d+$/.test(String(value))) throw new Error(`${flag} must be a non-negative integer`);
  }
  if (args.historyIndexVersion !== null) resolveObservationsTimeseriesLatestPath(args.historyIndexVersion);
  assertExperimentalPackOnlyDestination({
    mode: args.timeseriesBindingBackupMode,
    destRoot: args.destRoot,
    allowExperimentalPackOnly: args.allowExperimentalPackOnly,
  });
  if (
    args.timeseriesBindingPacksOnly
    && args.timeseriesBindingBackupMode !== "pack"
  ) {
    throw new Error("--timeseries-binding-packs-only requires pack backup mode");
  }
  return Object.freeze(args);
}

function runRequired(command, commandArgs, { env, run = spawnSync }) {
  const result = run(command, commandArgs, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) {
    const error = new Error(`${command} exited with status ${String(result.status)}`);
    error.exitCode = Number(result.status || 1);
    throw error;
  }
}

export function requireLockedHistoryBackupMutation({
  dryRun = false,
  env = process.env,
} = {}) {
  if (dryRun) return null;
  return requireObservationsGlobalOperationLockContext({
    env,
    expectedOwner: "r2_history_dropbox_backup",
  });
}

export function runLockedHistoryBackup({
  args,
  env = process.env,
  run = spawnSync,
} = {}) {
  const lock = requireObservationsGlobalOperationLockContext({
    env,
    expectedOwner: "r2_history_dropbox_backup",
  });
  const generation = resolveObservationHistoryGeneration(env);
  args = {
    ...args,
    observationsPrefix: args.observationsPrefix ?? generation.observations_prefix,
    runsPrefix: args.runsPrefix ?? generation.observations_runs_prefix,
    timeseriesBindingPrefix: args.timeseriesBindingPrefix ?? generation.timeseries_binding_index_prefix,
    historyIndexVersion: args.historyIndexVersion ?? generation.version,
  };
  assertObservationHistoryGenerationPrefixes(generation, {
    observationsPrefix: args.observationsPrefix, bindingPrefix: args.timeseriesBindingPrefix,
  });
  if (args.runsPrefix !== generation.observations_runs_prefix || args.historyIndexVersion !== generation.version ||
      args.corePrefix !== "history/v2/core") throw new Error("Backup arguments contradict selected complete generation");
  const node = process.execPath;
  if (args.timeseriesBindingBackupMode !== "individual") {
    runRequired(node, [
      "scripts/backup_r2/publish_timeseries_binding_backup_packs.mjs",
      "--binding-prefix", args.timeseriesBindingPrefix,
      "--pack-prefix", args.timeseriesBindingPackPrefix,
      ...(args.packPublisherReportOut
        ? ["--report-out", args.packPublisherReportOut]
        : []),
      args.dryRun ? "--dry-run" : "--write-r2",
    ], { env, run });
  }
  runRequired(node, [
    "scripts/backup_r2/build_backup_inventory.mjs",
    "--source-root", args.sourceRoot,
    "--observations-prefix", args.observationsPrefix,
    "--runs-prefix", args.runsPrefix,
    "--core-prefix", args.corePrefix,
    "--timeseries-binding-prefix", args.timeseriesBindingPrefix,
    "--timeseries-binding-backup-mode", args.timeseriesBindingBackupMode,
    "--timeseries-binding-pack-prefix", args.timeseriesBindingPackPrefix,
    "--history-index-version", args.historyIndexVersion,
    "--inventory-root-prefix", args.inventoryRootPrefix,
    "--report-out", args.inventoryReportOut,
  ], { env, run });
  runRequired(node, [
    "scripts/backup_r2/sync_history_to_dropbox.mjs",
    "--source-root", args.sourceRoot,
    "--dest-root", args.destRoot,
    "--inventory-root-prefix", args.inventoryRootPrefix,
    "--state-root-prefix", args.stateRootPrefix,
    "--timeseries-binding-backup-mode", args.timeseriesBindingBackupMode,
    "--max-days-per-run", args.maxDaysPerRun,
    "--checkpoint-batch-units", args.checkpointBatchUnits,
    "--checkpoint-flush-seconds", args.checkpointFlushSeconds,
    "--report-out", args.backupReportOut,
    ...(args.dryRun ? ["--dry-run"] : []),
    ...(args.forcePruneRecheck ? ["--force-prune-recheck"] : []),
    ...(args.allowExperimentalPackOnly ? ["--allow-experimental-pack-only"] : []),
    ...(args.timeseriesBindingPacksOnly ? ["--timeseries-binding-packs-only"] : []),
  ], { env, run });
  return {
    ok: true,
    observations_global_operation_lock: {
      owner: lock.owner,
      run_id: lock.run_id,
      logical_identity: lock.logical_identity,
      acquired: lock.acquired,
      wait_ms: lock.wait_ms,
      outcome: lock.outcome,
      boundary: "inventory_through_copy_verification_and_checkpoint_publication",
    },
  };
}

export function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const result = runLockedHistoryBackup({
    args: parseLockedHistoryBackupArgs(argv),
    env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = Number(error?.exitCode || 1);
  }
}
