#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  isRcloneNotFoundMessage,
  joinTargetPath,
  rcloneCat,
  rcloneCatMaybe,
  rcloneLsjsonRecursive,
  runRclone,
} from "./lib/rclone.mjs";

const LEGACY_CHECKPOINT_BASE = "_ops/checkpoints/r2_history_backup_state_v2";

export function legacyCheckpointPrefix(version) {
  getObservationHistoryGeneration(version);
  return version === "v2" ? LEGACY_CHECKPOINT_BASE : `${LEGACY_CHECKPOINT_BASE}/generation=v3`;
}

export function rewriteCheckpointRoot(root, generation, sourcePrefix) {
  if (!root || typeof root !== "object" || Array.isArray(root) ||
      root.kind !== "uk_aq_r2_history_backup_state_v2_root" || root.backup_version !== "v2") {
    throw new Error("Legacy checkpoint root identity is invalid");
  }
  if (generation.version === "v3" && root.observation_generation !== "v3") {
    throw new Error("Legacy v3 checkpoint does not identify observation_generation v3");
  }
  if (generation.version === "v2" && root.observation_generation !== undefined && root.observation_generation !== "v2") {
    throw new Error("Legacy v2 checkpoint contradicts observation_generation v2");
  }
  const sourceStart = `${sourcePrefix}/`;
  const destinationStart = `${generation.backup_state_prefix}/`;
  const rewriteKey = (value, label) => {
    if (typeof value !== "string" || !value.startsWith(sourceStart)) {
      throw new Error(`${label} is outside the selected legacy checkpoint tree`);
    }
    return `${destinationStart}${value.slice(sourceStart.length)}`;
  };
  const migrated = structuredClone(root);
  migrated.observation_generation = generation.version;
  for (const year of migrated.observations?.years || []) {
    for (const month of year.months || []) {
      month.state_shard_key = rewriteKey(month.state_shard_key, "Observation month state shard");
    }
  }
  const globalKey = migrated.global_units?.observation_run_manifests?.state_shard_key;
  migrated.global_units.observation_run_manifests.state_shard_key = rewriteKey(globalKey, "Run-manifest state shard");
  if (migrated.core?.state_shard_key) {
    migrated.core.state_shard_key = rewriteKey(migrated.core.state_shard_key, "Core state shard");
  }
  for (const range of migrated.timeseries_binding?.ranges || []) {
    range.state_shard_key = rewriteKey(range.state_shard_key, "Binding state shard");
  }
  for (const range of migrated.timeseries_binding_packs?.ranges || []) {
    range.state_shard_key = rewriteKey(range.state_shard_key, "Binding-pack state shard");
  }
  return migrated;
}

function parseArgs(argv) {
  const args = { dropboxRoot: "", version: "", rcloneBin: "rclone", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = String(argv[++i] || "").trim();
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--dropbox-root") args.dropboxRoot = value();
    else if (flag === "--observation-generation") args.version = value();
    else if (flag === "--rclone-bin") args.rcloneBin = value();
    else if (flag === "--apply") args.apply = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.dropboxRoot) throw new Error("--dropbox-root is required");
  args.generation = getObservationHistoryGeneration(args.version);
  return args;
}

function filters(version) {
  return version === "v2"
    ? ["--exclude", "/root.json", "--exclude", "/generation=v3/**", "--exclude", "/observation_generation=v2/**", "--exclude", "/observation_generation=v3/**"]
    : ["--exclude", "/root.json"];
}

export function migrateHierarchicalCheckpoint({ dropboxRoot, version, rcloneBin = "rclone", apply = false }) {
  const generation = getObservationHistoryGeneration(version);
  const sourcePrefix = legacyCheckpointPrefix(version);
  const destinationPrefix = generation.backup_state_prefix;
  const source = joinTargetPath(dropboxRoot, sourcePrefix);
  const destination = joinTargetPath(dropboxRoot, destinationPrefix);
  const sourceRootPath = joinTargetPath(dropboxRoot, `${sourcePrefix}/root.json`);
  const destinationRootPath = joinTargetPath(dropboxRoot, `${destinationPrefix}/root.json`);
  const sourceRoot = JSON.parse(rcloneCat(rcloneBin, sourceRootPath));
  const migratedRoot = rewriteCheckpointRoot(sourceRoot, generation, sourcePrefix);
  const existingDestinationRoot = rcloneCatMaybe(rcloneBin, destinationRootPath);
  const existingDestinationFiles = rcloneLsjsonRecursive(rcloneBin, destination, { hash: false });
  if (existingDestinationRoot.found || existingDestinationFiles.length) {
    throw new Error(`Canonical destination is not empty: ${destinationPrefix}`);
  }
  const report = {
    ok: true,
    mode: apply ? "apply" : "plan",
    observation_generation: version,
    source_prefix: sourcePrefix,
    destination_prefix: destinationPrefix,
    source_retained: true,
    source_file_count: rcloneLsjsonRecursive(rcloneBin, source, { hash: false }).filter((entry) => {
      const key = String(entry.Path || entry.Name || "");
      return key !== "root.json" && !(version === "v2" && (/^generation=v3\//.test(key) || /^observation_generation=v[23]\//.test(key)));
    }).length + 1,
  };
  if (!apply) return report;

  runRclone(rcloneBin, ["copy", source, destination, ...filters(version)]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-checkpoint-migration-"));
  try {
    const rootFile = path.join(tempDir, "root.json");
    fs.writeFileSync(rootFile, `${JSON.stringify(migratedRoot, null, 2)}\n`, { flag: "wx" });
    runRclone(rcloneBin, ["copyto", rootFile, destinationRootPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const check = runRclone(rcloneBin, ["check", source, destination, "--one-way", "--download", ...filters(version)], { allow_failure: true });
  if (check.status !== 0) {
    throw new Error(`Canonical checkpoint copy verification failed; legacy source retained\n${check.stderr || check.stdout}`);
  }
  const writtenRoot = JSON.parse(rcloneCat(rcloneBin, destinationRootPath));
  if (JSON.stringify(writtenRoot) !== JSON.stringify(migratedRoot)) {
    throw new Error("Canonical checkpoint root verification failed; legacy source retained");
  }
  const destinationFiles = rcloneLsjsonRecursive(rcloneBin, destination, { hash: false });
  if (destinationFiles.length !== report.source_file_count) {
    throw new Error(`Canonical checkpoint file-count verification failed (${destinationFiles.length} != ${report.source_file_count}); legacy source retained`);
  }
  report.verified = true;
  report.destination_file_count = destinationFiles.length;
  return report;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = migrateHierarchicalCheckpoint({
    dropboxRoot: args.dropboxRoot,
    version: args.version,
    rcloneBin: args.rcloneBin,
    apply: args.apply,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    const message = error instanceof Error ? error.stack : String(error);
    if (isRcloneNotFoundMessage(message)) process.stderr.write(`Legacy checkpoint source is missing\n${message}\n`);
    else process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
