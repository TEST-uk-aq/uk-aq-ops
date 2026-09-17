#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getObservationHistoryGeneration,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  assertSelectedBackupInventory,
  validateHierarchicalInventoryRoot,
} from "./lib/hierarchical_backup_v2.mjs";
import {
  joinTargetPath,
  rcloneCat,
  runRclone,
} from "./lib/rclone.mjs";
import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";

const APPLY_LOCK_OWNER = "r2_history_inventory_generation_migration";

function parseArgs(argv, env = process.env) {
  const args = {
    sourceRoot: "",
    version: "",
    rcloneBin: String(env.RCLONE_BIN || "rclone").trim() || "rclone",
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = String(argv[++index] || "").trim();
      if (!next || next.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return next;
    };

    if (flag === "--source-root") args.sourceRoot = value();
    else if (flag === "--observation-generation") args.version = value();
    else if (flag === "--rclone-bin") args.rcloneBin = value();
    else if (flag === "--apply") args.apply = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  if (!args.sourceRoot) throw new Error("--source-root is required");
  if (!args.version) throw new Error("--observation-generation is required");

  args.generation = getObservationHistoryGeneration(args.version);
  if (args.generation.version !== "v2") {
    throw new Error(
      "This one-off migration only supports the legacy v2 backup inventory",
    );
  }

  return args;
}

function validateLegacyInventoryRoot(root) {
  return validateHierarchicalInventoryRoot(root, {
    requireLatestTimeseries: true,
    validateTimeseriesBindingPacks: true,
  });
}

export function prepareInventoryGenerationMigration(root, generation) {
  if (generation !== getObservationHistoryGeneration(generation?.version)) {
    throw new Error(
      "Migration requires an immutable shared observation generation",
    );
  }
  if (generation.version !== "v2") {
    throw new Error(
      "This one-off migration only supports the legacy v2 backup inventory",
    );
  }

  const validatedCurrent = validateLegacyInventoryRoot(root);
  const hasGeneration = Object.prototype.hasOwnProperty.call(
    root,
    "observation_generation",
  );

  if (hasGeneration && root.observation_generation !== "v2") {
    throw new Error(
      `Existing backup inventory contradicts v2: observation_generation=${JSON.stringify(root.observation_generation)}`,
    );
  }

  if (hasGeneration) {
    assertSelectedBackupInventory(generation, validatedCurrent);
    return {
      changed: false,
      root,
      validated: validatedCurrent,
    };
  }

  // This is deliberately the only semantic mutation.
  const candidate = structuredClone(root);
  candidate.observation_generation = "v2";

  const validatedCandidate = validateLegacyInventoryRoot(candidate);

  // This is the key fail-closed gate. Because the only field added above is
  // observation_generation, passing this proves that the existing inventory
  // already points at the complete selected v2 generation.
  assertSelectedBackupInventory(generation, validatedCandidate);

  const comparison = structuredClone(candidate);
  delete comparison.observation_generation;
  if (JSON.stringify(comparison) !== JSON.stringify(root)) {
    throw new Error(
      "Inventory migration attempted to change fields other than observation_generation",
    );
  }

  return {
    changed: true,
    root: candidate,
    validated: validatedCandidate,
  };
}

export function migrateBackupInventoryGeneration({
  sourceRoot,
  version,
  rcloneBin = "rclone",
  apply = false,
  env = process.env,
  operations = {},
}) {
  const generation = getObservationHistoryGeneration(version);
  if (generation.version !== "v2") {
    throw new Error(
      "This one-off migration only supports the legacy v2 backup inventory",
    );
  }

  const {
    cat = rcloneCat,
    run = runRclone,
  } = operations;

  if (apply) {
    requireObservationsGlobalOperationLockContext({
      env,
      expectedOwner: APPLY_LOCK_OWNER,
    });
  }

  const inventoryRootKey = `${generation.backup_inventory_prefix}/root.json`;
  const inventoryRootPath = joinTargetPath(sourceRoot, inventoryRootKey);

  const sourceText = cat(rcloneBin, inventoryRootPath);
  const sourceRootObject = JSON.parse(sourceText);
  const prepared = prepareInventoryGenerationMigration(sourceRootObject, generation);

  const report = {
    ok: true,
    mode: apply ? "apply" : "plan",
    observation_generation: generation.version,
    inventory_root_key: inventoryRootKey,
    inventory_root_path: inventoryRootPath,
    changed: prepared.changed,
    existing_generation_marker:
      Object.prototype.hasOwnProperty.call(
        sourceRootObject,
        "observation_generation",
      )
        ? sourceRootObject.observation_generation
        : null,
    action: prepared.changed
      ? "add observation_generation=v2 to existing validated inventory root"
      : "no change; inventory already identifies v2",
  };

  if (!prepared.changed || !apply) {
    return report;
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "uk-aq-inventory-generation-migration-"),
  );

  try {
    const rootFile = path.join(tempDir, "root.json");
    fs.writeFileSync(
      rootFile,
      `${JSON.stringify(prepared.root, null, 2)}\n`,
      { flag: "wx" },
    );
    run(rcloneBin, ["copyto", rootFile, inventoryRootPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const writtenRoot = JSON.parse(cat(rcloneBin, inventoryRootPath));

  if (JSON.stringify(writtenRoot) !== JSON.stringify(prepared.root)) {
    throw new Error(
      "Backup inventory root verification failed after write",
    );
  }

  const verifiedRoot = validateLegacyInventoryRoot(writtenRoot);
  assertSelectedBackupInventory(generation, verifiedRoot);

  report.verified = true;
  report.written_generation_marker = writtenRoot.observation_generation;
  return report;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, env);
  const report = migrateBackupInventoryGeneration({
    sourceRoot: args.sourceRoot,
    version: args.version,
    rcloneBin: args.rcloneBin,
    apply: args.apply,
    env,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
