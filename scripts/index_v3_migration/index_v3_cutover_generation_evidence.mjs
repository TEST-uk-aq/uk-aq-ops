// Read-only evidence shared by the immutable cut-over and advanced-generation
// verifiers. Publication, journal repair and migration execution remain owned by
// the existing migration operator; none are called here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  buildObservationHistoryV3RecoveryProgressContext,
} from "../backup_r2/uk_aq_observation_history_migration_v3.mjs";
import {
  assertSideBySideMigrationPlan,
  buildObservationHistoryV3RerunVerificationPlan,
} from "../backup_r2/lib/observation_history_migration_v3.mjs";
import {
  resolveObservationHistoryGeneration,
  assertObservationHistoryGenerationPrefixes,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  assertSelectedBackupInventory,
  validateHierarchicalInventoryRoot,
} from "../backup_r2/lib/hierarchical_backup_v2.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");

export function selectedCutoverGeneration(env) {
  const generation = resolveObservationHistoryGeneration(env);
  if (generation.version !== "v3") throw new Error("Cut-over verification requires selected complete v3");
  assertObservationHistoryGenerationPrefixes(generation, {
    observationsPrefix: env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || generation.observations_prefix,
    runsPrefix: env.UK_AQ_R2_HISTORY_V2_RUNS_PREFIX || generation.observations_runs_prefix,
    corePrefix: env.UK_AQ_R2_HISTORY_V2_CORE_PREFIX || generation.core_prefix,
    inventoryPrefix: env.UK_AQ_R2_HISTORY_HIERARCHICAL_INVENTORY_PREFIX || generation.backup_inventory_prefix,
    bindingPrefix: env.UK_AQ_R2_HISTORY_TIMESERIES_BINDING_V2_PREFIX || generation.timeseries_binding_index_prefix,
    statePrefix: env.UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX || generation.backup_state_prefix,
    indexRoot: env.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX || generation.observations_timeseries_index_prefix,
  });
  for (const [name, expected] of [
    ["UK_AQ_R2_HISTORY_INDEX_V2_PREFIX", generation.index_root_prefix],
    ["UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX", generation.timeseries_binding_index_prefix],
  ]) {
    if (env[name] && env[name] !== expected) throw new Error(`${name} contradicts selected v3`);
  }
  return generation;
}

export function readAuthenticatedCutoverBaseline({ checkpointPath, planReport, environment, bucket }) {
  const bytes = fs.readFileSync(checkpointPath);
  const original = JSON.parse(bytes.toString("utf8"));
  const recovery = buildObservationHistoryV3RecoveryProgressContext({
    checkpointPath, checkpoint: original, repositoryRoot,
    create: false, repairHead: false, requireCurrentImplementation: true,
  });
  const checkpoint = recovery.checkpoint;
  if (!recovery.fullVerificationComplete || !recovery.cutoverReady) {
    throw new Error("Migration recovery evidence is not fully verified and cut-over ready");
  }
  const plan = buildObservationHistoryV3RerunVerificationPlan({
    checkpoint, allowLegacyRecoveryOrdering: false,
    recoveryAuthority: recovery.authenticatedRecoveryAuthority,
  });
  assertSideBySideMigrationPlan(plan);
  if (plan.environment.environment !== environment || plan.environment.bucket !== bucket ||
      planReport?.result?.plan_sha256 !== plan.plan_sha256 ||
      planReport?.result?.migration_run_id !== plan.migration_run_id) {
    throw new Error("Migration baseline differs from explicit environment/bucket or supplied plan report");
  }
  const authority = recovery.authenticatedRecoveryAuthority;
  return {
    plan, checkpoint, completedObjects: new Map([...recovery.completedEvidence].map(([key, evidence]) => [key, { evidence }])),
    provenance: {
      kind: "authenticated_completed_migration_recovery_journal",
      pre_migration_dropbox_source: false,
      checkpoint_sha256: sha256(bytes), checkpoint_byte_size: bytes.byteLength,
      immutable_authority_sha256: authority.immutable_authority_sha256,
      recovery_head_sha256: sha256(fs.readFileSync(path.join(recovery.paths.root, "head.json"))),
      recovery_last_sequence: authority.last_sequence,
      recovery_last_entry_sha256: authority.last_entry_sha256,
      migration_run_id: plan.migration_run_id, plan_sha256: plan.plan_sha256,
      target_writer_git_sha: plan.target_writer_git_sha,
      recovery_reconciliation_mode: plan.recovery_reconciliation.mode,
    },
  };
}

export async function verifySelectedCutoverMetadata({ generation, getObject, headObject }) {
  // The first normal Core Snapshot and inventory follow the controlled first
  // Prune acceptance. Absence here is explicitly pending, never a v2 fallback.
  const key = `${generation.backup_inventory_prefix}/root.json`;
  const head = await headObject({ key });
  if (head?.exists === false) return {
    generation, inventory_key: key, inventory_status: "not_yet_established",
    core_status: "pending_normal_core_snapshot_and_backup_evidence",
    backup_verified: false,
  };
  if (head?.exists !== true) throw new Error("Selected inventory HEAD did not establish existence or absence");
  const body = Buffer.from((await getObject({ key })).body);
  const inventory = assertSelectedBackupInventory(generation,
    validateHierarchicalInventoryRoot(JSON.parse(body.toString("utf8"))));
  return {
    generation, inventory_key: key, inventory_status: "selected_generation_coherent",
    inventory_sha256: sha256(body), core_prefix: inventory.core.source_prefix,
    core_status: "selected_inventory_pointer_only", backup_verified: false,
  };
}
