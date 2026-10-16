// Read-only evidence shared by the immutable cut-over and advanced-generation
// verifiers. Publication, journal repair and migration execution remain owned by
// the existing migration operator; none are called here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildObservationHistoryV3RecoveryProgressContext,
} from "../backup_r2/uk_aq_observation_history_migration_v3.mjs";
import {
  assertSideBySideMigrationPlan,
  buildObservationHistoryV3RerunVerificationPlan,
} from "../backup_r2/lib/observation_history_migration_v3.mjs";
import { readShardedMigrationPlan } from "../backup_r2/lib/observation_history_migration_plan_store.mjs";
import {
  resolveObservationHistoryGeneration,
  assertObservationHistoryGenerationPrefixes,
} from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  assertSelectedBackupInventory,
  validateHierarchicalInventoryRoot,
} from "../backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  EXCEPTIONAL_LIVE_RECOVERY,
  authenticateExceptionalRecovery,
} from "./exceptional_recovery_authority.mjs";
import { createEvidenceRelocation } from "./evidence_relocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");

// Current verifier/recovery machinery is trusted at the reviewed current HEAD;
// the semantic subset below is additionally pinned to the historical writer.
// Keep the current list operational rather than treating it as migration
// output authority: these files may evolve after the migration when the
// current reviewed verifier remains authenticated.
export const VERIFY_CURRENT_TRUSTED_DEPENDENCIES = Object.freeze([
  "scripts/index_v3_migration/index_v3_live_immutable_verify.mjs",
  "scripts/index_v3_migration/index_v3_cutover_generation_evidence.mjs",
  "scripts/index_v3_migration/evidence_relocation.mjs",
  "scripts/index_v3_migration/recovery_journal_authority.mjs",
  "scripts/index_v3_migration/exceptional_recovery_authority.mjs",
  "scripts/index_v3_migration/operator_execution.mjs",
  "scripts/index_v3_migration/v2_runtime_artifact.mjs",
  "scripts/index_v3_migration/index_v3_capture_operator_evidence.mjs",
  "scripts/index_v3_migration/capture_v2_runtime_authority.mjs",
  "scripts/index_v3_migration/v2_runtime_recovery.mjs",
  "scripts/index_v3_migration/index_v3_operator_evidence.mjs",
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  "scripts/backup_r2/lib/observation_history_migration_v3.mjs",
  "scripts/backup_r2/lib/observation_history_migration_plan_store.mjs",
  "scripts/backup_r2/lib/observation_history_migration_concurrency.mjs",
  "scripts/backup_r2/lib/observation_history_migration_gcp.mjs",
  "scripts/backup_r2/lib/observation_history_migration_worker_pool.mjs",
  "scripts/backup_r2/lib/observation_history_migration_worker.mjs",
  "scripts/backup_r2/lib/observation_history_migration_bounded_r2.mjs",
  "scripts/backup_r2/lib/observation_history_generation_bindings.mjs",
  "scripts/backup_r2/lib/hierarchical_backup_v2.mjs",
  "scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs",
  "scripts/backup_r2/uk_aq_build_r2_history_index.mjs",
  "scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs",
  "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
  "package.json",
  "package-lock.json",
  "workers/shared/uk_aq_observation_history_generation.mjs",
  "workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs",
  "workers/shared/uk_aq_observation_history_index_v3.mjs",
  "workers/shared/uk_aq_observation_history_schema.mjs",
  "workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs",
  "workers/shared/uk_aq_observation_history_target_writer.mjs",
  "workers/shared/uk_aq_observation_history_writer_limits_v3.mjs",
  "workers/shared/uk_aq_r2_checksum_publication.mjs",
  "workers/shared/uk_aq_r2_history_index.mjs",
  "workers/shared/uk_aq_r2_history_canonical.mjs",
  "workers/shared/uk_aq_r2_file_identity.mjs",
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs",
  "workers/shared/uk_aq_observation_content_hash.mjs",
  "workers/shared/uk_aq_observation_property_code.mjs",
  "workers/shared/r2_sigv4.mjs",
  "workers/shared/uk_aq_r2_history_writer.mjs",
]);

export const VERIFY_HISTORICALLY_PINNED_SEMANTIC_DEPENDENCIES = Object.freeze([
  "scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs",
  "workers/shared/uk_aq_observation_content_hash.mjs",
  "workers/shared/uk_aq_observation_history_index_v3.mjs",
  "workers/shared/uk_aq_observation_history_schema.mjs",
  "workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs",
  "workers/shared/uk_aq_observation_history_target_writer.mjs",
  "workers/shared/uk_aq_observation_history_writer_limits_v3.mjs",
  "workers/shared/uk_aq_observation_property_code.mjs",
  "workers/shared/uk_aq_r2_history_canonical.mjs",
  "workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs",
]);

function gitOutput(root, args) {
  const result = spawnSync("git", args, {
    cwd: root, encoding: null, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Verifier Git dependency authentication failed: git ${args.join(" ")}`);
  }
  return result.stdout;
}

function requireTrackedRegularFile(root, relativePath) {
  const tree = gitOutput(root, ["ls-tree", "HEAD", "--", relativePath]).toString("utf8").trim();
  if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(tree)) {
    throw new Error(`Current verifier dependency is not a tracked regular file: ${relativePath}`);
  }
  const localPath = path.join(root, relativePath);
  const stat = fs.lstatSync(localPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Current verifier dependency is missing or unsafe: ${relativePath}`);
  }
  return localPath;
}

export function authenticateCutoverVerifierDependencies({
  repositoryRoot: rootPath = repositoryRoot,
  historicalWriterGitSha,
}) {
  const root = path.resolve(rootPath);
  if (!/^[0-9a-f]{40}$/.test(String(historicalWriterGitSha || ""))) {
    throw new Error("Historical migration writer Git SHA is missing or malformed");
  }
  for (const relativePath of VERIFY_CURRENT_TRUSTED_DEPENDENCIES) {
    const localPath = requireTrackedRegularFile(root, relativePath);
    const currentHead = gitOutput(root, ["show", `HEAD:${relativePath}`]);
    if (!fs.readFileSync(localPath).equals(currentHead)) {
      throw new Error(`Current verifier dependency differs from clean HEAD: ${relativePath}`);
    }
    if (gitOutput(root, ["diff", "--exit-code", "HEAD", "--", relativePath]).length ||
        gitOutput(root, ["diff", "--cached", "--exit-code", "HEAD", "--", relativePath]).length) {
      throw new Error(`Current verifier dependency has uncommitted drift: ${relativePath}`);
    }
  }
  for (const relativePath of VERIFY_HISTORICALLY_PINNED_SEMANTIC_DEPENDENCIES) {
    const historical = gitOutput(root, ["show", `${historicalWriterGitSha}:${relativePath}`]);
    const current = gitOutput(root, ["show", `HEAD:${relativePath}`]);
    if (!historical.equals(current)) {
      throw new Error(`Historically pinned semantic dependency changed: ${relativePath}`);
    }
  }
  return Object.freeze({
    current_trusted_dependencies: VERIFY_CURRENT_TRUSTED_DEPENDENCIES,
    historically_pinned_semantic_dependencies: VERIFY_HISTORICALLY_PINNED_SEMANTIC_DEPENDENCIES,
    historical_writer_git_sha: historicalWriterGitSha,
  });
}

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

function readCutoverCheckpoint({ checkpointPath, evidenceRoot }) {
  const bytes = fs.readFileSync(checkpointPath);
  const original = JSON.parse(bytes.toString("utf8"));
  if (original.authority_format !== "uk_aq_migration_plan_shards_v1") return { checkpoint: original, bytes };
  const manifestPath = `${path.resolve(checkpointPath)}.recovery/manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const historicalCheckpointPath = manifest?.payload?.original_checkpoint?.path;
  const relocation = createEvidenceRelocation({
    historicalCheckpointPath,
    localCheckpointPath: checkpointPath,
    evidenceRoot,
  });
  const localReference = {
    ...original.authority_ref,
    master_path: relocation.mapHistoricalPath(original.authority_ref.master_path, "Sharded migration plan master"),
  };
  const { plan } = readShardedMigrationPlan(localReference);
  if (original.authority_ref.full_plan_sha256 !== original.authority_sha256 ||
      original.plan_sha256 !== plan.plan_sha256 || original.migration_run_id !== plan.migration_run_id) {
    throw new Error("Migration checkpoint contradicts its relocated sharded immutable authority");
  }
  return { checkpoint: { ...original, authority: plan }, bytes };
}

export function readAuthenticatedCutoverBaseline({ checkpointPath, planReport, environment, bucket, evidenceRoot = null }) {
  const { checkpoint: original, bytes } = readCutoverCheckpoint({ checkpointPath, evidenceRoot });
  let exceptionalRecovery = null;
  const recovery = buildObservationHistoryV3RecoveryProgressContext({
    checkpointPath, checkpoint: original, repositoryRoot,
    create: false, repairHead: false,
    // The read-only verifier authenticates current machinery separately below.
    // The immutable recovery manifest remains historical authority and must not
    // be repinned to the current verifier checkout.
    requireCurrentImplementation: false,
    readOnly: true,
    evidenceRoot,
    onAuthenticatedReplay: ({ journal }) => {
      if (original.migration_run_id === EXCEPTIONAL_LIVE_RECOVERY.run_id) {
        exceptionalRecovery = authenticateExceptionalRecovery({
          checkpointPath, repositoryRoot, authenticatedJournal: journal,
          authenticatedCheckpoint: original, authenticatedCheckpointBytes: bytes, evidenceRoot,
        });
      }
    },
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
  const verifierTrust = authenticateCutoverVerifierDependencies({
    repositoryRoot, historicalWriterGitSha: plan.target_writer_git_sha,
  });
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
      verifier_trust: verifierTrust,
      evidence_relocation: recovery.evidenceRelocation ? {
        historical_checkpoint_path: recovery.evidenceRelocation.historical_checkpoint_path,
        local_checkpoint_path: recovery.evidenceRelocation.local_checkpoint_path,
        evidence_root: recovery.evidenceRelocation.evidence_root,
        relocated: recovery.evidenceRelocation.relocated,
      } : null,
      ...(exceptionalRecovery ? { exceptional_recovery: {
        kind: "authenticated_exceptional_recovery_epoch_ledger",
        original_writer_git_sha: exceptionalRecovery.originalImplementation.repository_head,
        current_recovery_implementation_git_sha: exceptionalRecovery.currentImplementation.repository_head,
        original_journal_anchor: {
          sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence,
          entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256,
        },
        recovery_epoch_sequence: exceptionalRecovery.recoveryEpoch.sequence,
        recovery_epoch_sha256: exceptionalRecovery.recoveryEpoch.last_epoch_sha256,
      } } : {}),
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
