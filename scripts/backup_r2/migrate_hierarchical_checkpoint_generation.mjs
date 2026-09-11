#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  assertSelectedBackupState,
  validateHierarchicalStateRoot,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  isRcloneNotFoundMessage,
  joinTargetPath,
  rcloneCat,
  rcloneCatMaybe,
  rcloneLsjsonRecursive,
  runRclone,
} from "./lib/rclone.mjs";
import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

const LEGACY_CHECKPOINT_BASE = "_ops/checkpoints/r2_history_backup_state_v2";

export function legacyCheckpointPrefix(version) {
  getObservationHistoryGeneration(version);
  return version === "v2" ? LEGACY_CHECKPOINT_BASE : `${LEGACY_CHECKPOINT_BASE}/generation=v3`;
}

export function rewriteCheckpointRoot(root, generation, sourcePrefix) {
  if (generation !== getObservationHistoryGeneration(generation?.version)) {
    throw new Error("Migration requires an immutable shared observation generation");
  }
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
  if (sourcePrefix !== legacyCheckpointPrefix(generation.version)) {
    throw new Error("Legacy checkpoint source prefix contradicts selected generation");
  }
  const sourceStart = `${sourcePrefix}/`;
  const destinationStart = `${generation.backup_state_prefix}/`;
  const forbiddenPrefixes = [
    `${LEGACY_CHECKPOINT_BASE}/observation_generation=v2/`,
    `${LEGACY_CHECKPOINT_BASE}/observation_generation=v3/`,
    ...(generation.version === "v2"
      ? [`${LEGACY_CHECKPOINT_BASE}/generation=v3/`]
      : []),
  ];
  const rewriteKey = (value, label, expectedRelativePrefix) => {
    const segments = typeof value === "string" ? value.split("/") : [];
    if (typeof value !== "string" || value !== value.trim() || value.startsWith("/") ||
        value.endsWith("/") || value.includes("\\") || segments.some((part) => !part || part === "." || part === "..") ||
        forbiddenPrefixes.some((prefix) => value.startsWith(prefix)) ||
        !value.startsWith(`${sourceStart}${expectedRelativePrefix}`)) {
      throw new Error(`${label} is outside the exact selected legacy namespace`);
    }
    return `${destinationStart}${value.slice(sourceStart.length)}`;
  };
  const migrated = structuredClone(root);
  migrated.observation_generation = generation.version;
  for (const year of migrated.observations?.years || []) {
    for (const month of year.months || []) {
      month.state_shard_key = rewriteKey(month.state_shard_key, "Observation month state shard", "observations/");
    }
  }
  const globalKey = migrated.global_units?.observation_run_manifests?.state_shard_key;
  migrated.global_units.observation_run_manifests.state_shard_key = rewriteKey(globalKey, "Run-manifest state shard", "global/");
  if (migrated.core?.state_shard_key) {
    migrated.core.state_shard_key = rewriteKey(migrated.core.state_shard_key, "Core state shard", "global/");
  }
  for (const range of migrated.timeseries_binding?.ranges || []) {
    range.state_shard_key = rewriteKey(range.state_shard_key, "Binding state shard", "timeseries_binding/");
  }
  for (const range of migrated.timeseries_binding_packs?.ranges || []) {
    range.state_shard_key = rewriteKey(range.state_shard_key, "Binding-pack state shard", "timeseries_binding_packs/");
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

export function migrateHierarchicalCheckpoint({
  dropboxRoot, version, rcloneBin = "rclone", apply = false, env = process.env,
  operations = {},
}) {
  const generation = getObservationHistoryGeneration(version);
  const {
    cat = rcloneCat,
    catMaybe = rcloneCatMaybe,
    lsjsonRecursive = rcloneLsjsonRecursive,
    run = runRclone,
  } = operations;
  if (apply) requireObservationsGlobalOperationLockContext({
    env, expectedOwner: "r2_history_checkpoint_migration",
  });
  const sourcePrefix = legacyCheckpointPrefix(version);
  const destinationPrefix = generation.backup_state_prefix;
  const source = joinTargetPath(dropboxRoot, sourcePrefix);
  const destination = joinTargetPath(dropboxRoot, destinationPrefix);
  const sourceRootPath = joinTargetPath(dropboxRoot, `${sourcePrefix}/root.json`);
  const destinationRootPath = joinTargetPath(dropboxRoot, `${destinationPrefix}/root.json`);
  const sourceRoot = JSON.parse(cat(rcloneBin, sourceRootPath));
  const migratedRoot = rewriteCheckpointRoot(sourceRoot, generation, sourcePrefix);
  const existingDestinationRoot = catMaybe(rcloneBin, destinationRootPath);
  const existingDestinationFiles = lsjsonRecursive(rcloneBin, destination, { hash: false });
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
    source_file_count: lsjsonRecursive(rcloneBin, source, { hash: false }).filter((entry) => {
      const key = String(entry.Path || entry.Name || "");
      return key !== "root.json" && !(version === "v2" && (/^generation=v3\//.test(key) || /^observation_generation=v[23]\//.test(key)));
    }).length + 1,
  };
  if (!apply) return report;

  const expectedNonRootFileCount = report.source_file_count - 1;
  run(rcloneBin, ["copy", source, destination, ...filters(version)]);
  const check = run(rcloneBin, ["check", source, destination, "--one-way", "--download", ...filters(version)], { allow_failure: true });
  if (check.status !== 0) {
    throw new Error(`Canonical checkpoint copy verification failed; legacy source retained\n${check.stderr || check.stdout}`);
  }
  const destinationFilesBeforeRoot = lsjsonRecursive(rcloneBin, destination, { hash: false });
  if (destinationFilesBeforeRoot.length !== expectedNonRootFileCount) {
    throw new Error(`Canonical checkpoint non-root file-count verification failed (${destinationFilesBeforeRoot.length} != ${expectedNonRootFileCount}); legacy source retained`);
  }
  const canonicalRoot = validateHierarchicalStateRoot(
    migratedRoot, generation.backup_state_prefix, generation,
  );
  assertSelectedBackupState(generation, canonicalRoot);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-checkpoint-migration-"));
  try {
    const rootFile = path.join(tempDir, "root.json");
    fs.writeFileSync(rootFile, `${JSON.stringify(canonicalRoot, null, 2)}\n`, { flag: "wx" });
    run(rcloneBin, ["copyto", rootFile, destinationRootPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const writtenRoot = JSON.parse(cat(rcloneBin, destinationRootPath));
  if (JSON.stringify(writtenRoot) !== JSON.stringify(canonicalRoot)) {
    throw new Error("Canonical checkpoint root verification failed; legacy source retained");
  }
  report.verified = true;
  report.destination_file_count = destinationFilesBeforeRoot.length + 1;
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
