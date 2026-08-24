#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

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
    latestTimeseriesKey: null,
    inventoryRootPrefix: null,
    stateRootPrefix: null,
    maxDaysPerRun: "0",
    checkpointBatchUnits: "10",
    checkpointFlushSeconds: "60",
    inventoryReportOut: null,
    backupReportOut: null,
    dryRun: false,
    forcePruneRecheck: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--force-prune-recheck") args.forcePruneRecheck = true;
    else {
      const value = requireValue(argv, index, flag);
      index += 1;
      if (flag === "--source-root") args.sourceRoot = value;
      else if (flag === "--dest-root") args.destRoot = value;
      else if (flag === "--observations-prefix") args.observationsPrefix = value;
      else if (flag === "--runs-prefix") args.runsPrefix = value;
      else if (flag === "--core-prefix") args.corePrefix = value;
      else if (flag === "--timeseries-binding-prefix") args.timeseriesBindingPrefix = value;
      else if (flag === "--latest-timeseries-key") args.latestTimeseriesKey = value;
      else if (flag === "--inventory-root-prefix") args.inventoryRootPrefix = value;
      else if (flag === "--state-root-prefix") args.stateRootPrefix = value;
      else if (flag === "--max-days-per-run") args.maxDaysPerRun = value;
      else if (flag === "--checkpoint-batch-units") args.checkpointBatchUnits = value;
      else if (flag === "--checkpoint-flush-seconds") args.checkpointFlushSeconds = value;
      else if (flag === "--inventory-report-out") args.inventoryReportOut = value;
      else if (flag === "--backup-report-out") args.backupReportOut = value;
      else throw new Error(`Unknown argument: ${flag}`);
    }
  }
  for (const [flag, value] of [
    ["--source-root", args.sourceRoot],
    ["--dest-root", args.destRoot],
    ["--observations-prefix", args.observationsPrefix],
    ["--runs-prefix", args.runsPrefix],
    ["--core-prefix", args.corePrefix],
    ["--timeseries-binding-prefix", args.timeseriesBindingPrefix],
    ["--latest-timeseries-key", args.latestTimeseriesKey],
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

export function runLockedHistoryBackup({
  args,
  env = process.env,
  run = spawnSync,
} = {}) {
  const lock = requireObservationsGlobalOperationLockContext({
    env,
    expectedOwner: "r2_history_dropbox_backup",
  });
  const node = process.execPath;
  runRequired(node, [
    "scripts/backup_r2/build_backup_inventory.mjs",
    "--source-root", args.sourceRoot,
    "--observations-prefix", args.observationsPrefix,
    "--runs-prefix", args.runsPrefix,
    "--core-prefix", args.corePrefix,
    "--timeseries-binding-prefix", args.timeseriesBindingPrefix,
    "--latest-timeseries-key", args.latestTimeseriesKey,
    "--inventory-root-prefix", args.inventoryRootPrefix,
    "--report-out", args.inventoryReportOut,
  ], { env, run });
  runRequired(node, [
    "scripts/backup_r2/sync_history_to_dropbox.mjs",
    "--source-root", args.sourceRoot,
    "--dest-root", args.destRoot,
    "--inventory-root-prefix", args.inventoryRootPrefix,
    "--state-root-prefix", args.stateRootPrefix,
    "--max-days-per-run", args.maxDaysPerRun,
    "--checkpoint-batch-units", args.checkpointBatchUnits,
    "--checkpoint-flush-seconds", args.checkpointFlushSeconds,
    "--report-out", args.backupReportOut,
    ...(args.dryRun ? ["--dry-run"] : []),
    ...(args.forcePruneRecheck ? ["--force-prune-recheck"] : []),
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
