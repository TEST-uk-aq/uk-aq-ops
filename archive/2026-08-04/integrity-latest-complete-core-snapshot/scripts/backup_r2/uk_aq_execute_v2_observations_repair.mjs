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

function finalPlannerError({
  reason,
  proposal,
  dependencyKey,
  identity,
  expectedSource,
  expectedSha256,
  expectedBytes,
  collisionDecision,
}) {
  const evidence = {
    reason,
    parent_object_key: String(proposal?.key || ""),
    dependency_object_key: dependencyKey,
    actual_source: identity?.source ?? null,
    expected_source: expectedSource,
    actual_sha256: identity?.sha256 ?? null,
    expected_sha256: expectedSha256,
    actual_bytes: identity?.bytes ?? null,
    expected_bytes: expectedBytes,
    proposal_owner: proposal?.proposal_owner
      || proposal?.provenance?.source
      || null,
    proposal_provenance: proposal?.proposal_provenance
      || proposal?.provenance
      || null,
    collision_decision: collisionDecision || null,
  };
  return new Error(
    `JavaScript final planner proposal validation failed: ${JSON.stringify(evidence)}`,
  );
}

export function validateFinalPlannerProposalGraph(output, { runState = null } = {}) {
  const proposals = output?.planning?.proposals;
  if (!Array.isArray(proposals)) {
    throw new Error(
      "JavaScript final planner proposal validation failed: final proposals are unavailable",
    );
  }
  const changed = new Map();
  for (const proposal of proposals) {
    if (proposal?.changed !== true) continue;
    const key = String(proposal?.key || "");
    if (!key || changed.has(key)) {
      throw finalPlannerError({
        reason: key ? "duplicate_changed_proposal_key" : "changed_proposal_key_missing",
        proposal,
        dependencyKey: key,
        identity: null,
        expectedSource: null,
        expectedSha256: null,
        expectedBytes: null,
        collisionDecision: null,
      });
    }
    changed.set(key, proposal);
  }
  const finalWriteIdentities = new Map();
  for (const [key, entry] of Object.entries(runState?.objects || {})) {
    if (entry?.proposed !== true
      || entry?.structurally_validated !== true
      || entry?.changed === false
      || entry?.included_in_write_set === false
      || entry?.status === "skipped_unchanged") continue;
    finalWriteIdentities.set(String(key), {
      sha256: String(entry.sha256 || entry.content_sha256 || ""),
      bytes: entry.bytes,
      source: "planned_overlay",
    });
  }
  for (const [key, proposal] of changed) {
    finalWriteIdentities.set(key, {
      sha256: String(proposal.new_sha256 || ""),
      bytes: proposal.bytes,
      source: "planned_overlay",
    });
  }
  const collisionByKey = new Map(
    (output?.planning?.compatibility_preparation?.collisions || [])
      .filter((entry) => entry?.key)
      .map((entry) => [String(entry.key), entry]),
  );
  let dependencyEdgeCount = 0;
  let stagedDependencyEdgeCount = 0;
  const externalDependencyEdgeCounts = { dropbox: 0, overlay: 0 };
  for (const proposal of changed.values()) {
    const dependencies = Array.isArray(proposal.dependencies)
      ? proposal.dependencies.map(String)
      : [];
    const identities = proposal?.dependency_identities;
    const collisionDecision = collisionByKey.get(String(proposal.key))
      ?.collision_decision
      || collisionByKey.get(String(proposal.key))?.status
      || null;
    if (!identities || typeof identities !== "object" || Array.isArray(identities)) {
      throw finalPlannerError({
        reason: "dependency_identity_map_invalid",
        proposal,
        dependencyKey: String(proposal.key),
        identity: null,
        expectedSource: null,
        expectedSha256: null,
        expectedBytes: null,
        collisionDecision,
      });
    }
    const identityKeys = Object.keys(identities).sort();
    const uniqueDependencies = [...new Set(dependencies)].sort();
    if (dependencies.length !== uniqueDependencies.length
      || JSON.stringify(identityKeys) !== JSON.stringify(uniqueDependencies)) {
      const differingKey = [...new Set([...identityKeys, ...uniqueDependencies])]
        .find((key) => !identityKeys.includes(key) || !uniqueDependencies.includes(key))
        || uniqueDependencies[0]
        || String(proposal.key);
      throw finalPlannerError({
        reason: "dependency_identity_set_mismatch",
        proposal,
        dependencyKey: differingKey,
        identity: identities[differingKey] || null,
        expectedSource: null,
        expectedSha256: null,
        expectedBytes: null,
        collisionDecision,
      });
    }
    for (const dependencyKey of uniqueDependencies) {
      dependencyEdgeCount += 1;
      const identity = identities[dependencyKey];
      const child = finalWriteIdentities.get(dependencyKey);
      const expectedSource = child ? "planned_overlay" : "dropbox_or_overlay";
      const expectedSha256 = child ? child.sha256 : null;
      const expectedBytes = child ? child.bytes : null;
      const identityShapeInvalid = !identity
        || !/^[a-f0-9]{64}$/.test(String(identity.sha256 || ""))
        || !Number.isSafeInteger(identity.bytes)
        || identity.bytes < 0;
      const stagedInvalid = child && (
        identity?.source !== "planned_overlay"
        || identity?.sha256 !== expectedSha256
        || identity?.bytes !== expectedBytes
      );
      const externalInvalid = !child
        && !["dropbox", "overlay"].includes(identity?.source);
      if (identityShapeInvalid || stagedInvalid || externalInvalid) {
        throw finalPlannerError({
          reason: child
            ? "staged_dependency_identity_mismatch"
            : identity?.source === "planned_overlay"
            ? "planned_overlay_dependency_missing_from_changed_write_set"
            : "external_dependency_identity_invalid",
          proposal,
          dependencyKey,
          identity,
          expectedSource,
          expectedSha256,
          expectedBytes,
          collisionDecision,
        });
      }
      if (child) stagedDependencyEdgeCount += 1;
      else externalDependencyEdgeCounts[identity.source] += 1;
    }
  }
  const audit = {
    status: "succeeded",
    changed_proposal_count: changed.size,
    final_changed_write_object_count: finalWriteIdentities.size,
    dependency_edge_count: dependencyEdgeCount,
    staged_dependency_edge_count: stagedDependencyEdgeCount,
    external_dependency_edge_counts: externalDependencyEdgeCounts,
    python_staging_permitted: true,
  };
  output.planning.final_planner_proposal_validation = audit;
  return audit;
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
  if (finalised?.ok === true) {
    const runStatePath = preparation.run_state_path
      || String(env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON || "");
    const runState = runStatePath
      ? JSON.parse(fs.readFileSync(runStatePath, "utf8"))
      : null;
    validateFinalPlannerProposalGraph(finalised, { runState });
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
