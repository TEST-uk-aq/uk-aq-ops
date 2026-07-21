#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export * from "./uk_aq_execute_v2_observations_repair_impl.mjs";

import {
  runV2ObservationsRepair as runV2ObservationsRepairImpl,
} from "./uk_aq_execute_v2_observations_repair_impl.mjs";
import {
  prepareCanonicalObservationManifestCompatibilityFromNormalisedView,
} from "../../workers/uk_aq_backfill_local/r2_history/canonical_manifest_compatibility_view.mjs";
import {
  finaliseLegacyObservationManifestCompatibility,
  prepareLegacyObservationManifestCompatibility,
} from "../../workers/uk_aq_backfill_local/r2_history/metadata_repair.mjs";
import {
  validateLegacyObservationManifestCompatibilityInputs,
} from "../../workers/uk_aq_backfill_local/r2_history/metadata_repair_guard.mjs";

function argvValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function resolvedEnvironment(env, argv) {
  const resolved = { ...env };
  const mappings = [
    ["--overlay-root", "UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT"],
    ["--dropbox-root", "UK_AQ_R2_HISTORY_DROPBOX_ROOT"],
    ["--run-state-json", "UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON"],
  ];
  for (const [flag, variable] of mappings) {
    const value = argvValue(argv, flag);
    if (value) resolved[variable] = value;
  }
  return resolved;
}

function resolveRepairPlan({ argv, repairPlan }) {
  if (repairPlan) return repairPlan;
  const jsonPath = argvValue(argv, "--repair-plan-json");
  if (jsonPath) return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (argv.includes("--repair-plan-stdin")) {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  }
  return null;
}

function mergePreparations(...values) {
  const preparedByConnector = new Map();
  let runStatePath = null;
  for (const value of values) {
    if (!value) continue;
    if (value.run_state_path) {
      if (runStatePath && runStatePath !== value.run_state_path) {
        throw new Error("Manifest compatibility preparations resolved different run-state files");
      }
      runStatePath = value.run_state_path;
    }
    for (const item of value.prepared || []) {
      const key = String(item?.connector_key || "");
      if (!key) throw new Error("Manifest compatibility preparation has no connector key");
      if (preparedByConnector.has(key)) {
        throw new Error(`Blocked dependency: multiple compatibility preparations for ${key}`);
      }
      preparedByConnector.set(key, item);
    }
  }
  return {
    prepared: [...preparedByConnector.values()]
      .sort((left, right) => left.connector_key.localeCompare(right.connector_key)),
    run_state_path: runStatePath,
  };
}

export async function runV2ObservationsRepair(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const env = resolvedEnvironment(options.env || process.env, argv);
  const repairPlan = resolveRepairPlan({
    argv,
    repairPlan: options.repairPlan || null,
  });
  const inputValidation = validateLegacyObservationManifestCompatibilityInputs({
    env,
    repairPlan,
  });
  const canonicalPreparation = await prepareCanonicalObservationManifestCompatibilityFromNormalisedView({
    env,
    repairPlan,
  });
  const legacyPreparation = await prepareLegacyObservationManifestCompatibility({
    env,
    repairPlan,
  });
  const preparation = mergePreparations(canonicalPreparation, legacyPreparation);
  const output = await runV2ObservationsRepairImpl({
    ...options,
    argv,
    env,
    repairPlan,
  });
  const finalised = finaliseLegacyObservationManifestCompatibility({
    output,
    preparation,
  });
  if (finalised?.planning
    && (inputValidation.legacy_connectors > 0 || preparation.prepared.length > 0)) {
    finalised.planning.compatibility_input_validation = {
      ...inputValidation,
      prepared_connectors: preparation.prepared.length,
      prepared_pollutant_manifests: preparation.prepared.reduce(
        (total, item) => total + Number(item?.pollutant_proposals?.length || 0),
        0,
      ),
    };
  }
  return finalised;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runV2ObservationsRepair().then((output) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
