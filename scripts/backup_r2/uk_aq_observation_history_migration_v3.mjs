#!/usr/bin/env node
import { runOperatorCommand, createOperatorProgress, withOperatorPhase, superviseOperatorInvocation, finishOperatorProgress } from "../index_v3_migration/operator_execution.mjs";

import fs from "node:fs";
import { validateDurableRuntimeEvidence, readRuntimePackage, runtimeDescriptor, runtimeJson, assertRuntimeRecordPin } from "../index_v3_migration/v2_runtime_artifact.mjs";
import { cloudflareCaptureCredentials } from "../index_v3_migration/index_v3_capture_operator_evidence.mjs";
import { verifyCurrentRuntimeEvidence } from "../index_v3_migration/capture_v2_runtime_authority.mjs";
import { inspectArtifactRecovery, uploadPinnedRuntime, verifyArtifactRuntime, workerRuntimeRequest } from "../index_v3_migration/v2_runtime_recovery.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  finalizeObservationHistoryIndexV3Publication,
} from "../../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  putAndVerifyR2ObjectWithSha256,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import {
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2HistoryV2ObservationsTimeseriesLatestKey,
  r2PutObjectIfChanged,
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  observationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  runCommandWithObservationsGlobalOperationLock,
} from "../operations/uk_aq_with_observations_global_operation_lock.mjs";
import {
  readAndValidateRecoveryJournal,
} from "../index_v3_migration/recovery_journal_authority.mjs";
import {
  validateIndexV3OperatorEvidence,
} from "../index_v3_migration/index_v3_operator_evidence.mjs";
import { runHistoryIndexBuild } from "./uk_aq_build_r2_history_index.mjs";
import {
  buildObservationHistoryV2RestorePlan,
  buildObservationHistoryV3MigrationAuditReport,
  buildObservationHistoryV3MigrationPlan,
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
  buildObservationHistoryV3RecoveryReplayStateSha256,
  createMigrationProgressReporter,
  buildObservationHistoryV3RerunVerificationPlan,
  DEFAULT_OBSERVATIONS_PREFIX,
  DEFAULT_V3_INDEX_ROOT,
  DEFAULT_V3_LATEST_KEY,
  executeObservationHistoryV2Rollback,
  executeObservationHistoryV3MigrationPlan,
  inventoryAuthoritativeCanonicalObservationHistory,
  stableMigrationJson,
  validateObservationHistoryV3MigrationEnvironment,
  verifyObservationHistoryDropboxCheckpoint,
  verifyObservationHistoryV2IndexCompleteness,
  verifyObservationHistoryV3CurrentDependencies,
} from "./lib/observation_history_migration_v3.mjs";
const MODES = new Set([
  "runtime-recoverability",
  "plan",
  "migrate",
  "verify",
  "rollback-plan",
  "rollback",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs [options]",
    "",
    "Modes:",
    "  --mode plan             Build non-mutating pinned inventory/rollback authority (default)",
    "  --mode migrate          Execute the offline rewrite and complete v3 publication",
    "  --mode verify           Rerun complete verification without mutation",
    "  --mode rollback-plan    Build the transition-specific exact restore plan",
    "  --mode runtime-recoverability  Read-only pinned runtime route check; requires environment, transition, runtime record and report-out only",
    "  --mode rollback         Restore canonical v2, rebuild/verify index_v2, then restore/verify v2 runtime authority",
    "",
    "Required for every mode:",
    "  --environment TEST|LIVE",
    "  --transition v2-to-v3|v3-rebuild",
    "  --expected-bucket <exact environment bucket>",
    "  --migration-run-id <stable operator identity>",
    "  --target-writer-git-sha <exact deployed migration code identity>",
    "  --writer-limits-json <Phase 1 writer limits JSON>",
    "  --dropbox-root <local directory or rclone remote:path>",
    "  --expected-inventory-root-sha256 <hex>",
    "  --expected-state-root-sha256 <hex>",
    "  --report-out <audit JSON path>",
    "  --expected-plan-sha256 <hex>  Required except for plan",
    "",
    "Mutation-only requirements:",
    "  --apply                  Explicitly permit the selected external mutation",
    "  --writers-frozen         Confirm every planner-listed writer is paused",
    "  --checkpoint-out <path>  Required for migrate; atomically updated after each object",
    "  --v2-runtime-rollback-record <path>  Required for fresh migration and rollback; pinned by new authority",
    "  --operator-authority-file <path>    Required for migrate/resume and all schema-2 runtime evidence use",
    "",
    "  --publication-concurrency <1..16>  Concurrent v3 publications (default: 1)",
    "",
    "Resume/verify:",
    "  --checkpoint-in <path>   Prior checkpoint; required for verify/rollback and migrate resume",
    "",
    "Migration modes never change configuration, scheduler state, deployments, or reader generation.",
    "Rollback changes only the pinned v2 Worker deployments and persistent index authority after canonical/index verification.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parsePublicationConcurrency(value) {
  if (!/^(?:[1-9]|1[0-6])$/.test(String(value))) {
    throw new Error("--publication-concurrency must be an integer from 1 to 16");
  }
  return Number(value);
}

export function parseObservationHistoryMigrationArgs(argv) {
  const args = {
    mode: "plan",
    transition: null,
    apply: false,
    writersFrozen: false,
    environment: null,
    expectedBucket: null,
    migrationRunId: null,
    targetWriterGitSha: null,
    writerLimitsPath: null,
    dropboxRoot: null,
    expectedInventoryRootSha256: null,
    expectedStateRootSha256: null,
    v2RuntimeRollbackRecord: null,
    operatorAuthorityFile: null,
    reportOut: null,
    checkpointIn: null,
    checkpointOut: null,
    expectedPlanSha256: null,
    publicationConcurrency: 1,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--writers-frozen") args.writersFrozen = true;
    else if (flag === "--mode") args.mode = requireValue(argv, index++, flag);
    else if (flag === "--transition") args.transition = requireValue(argv, index++, flag);
    else if (flag === "--environment") args.environment = requireValue(argv, index++, flag);
    else if (flag === "--expected-bucket") args.expectedBucket = requireValue(argv, index++, flag);
    else if (flag === "--migration-run-id") args.migrationRunId = requireValue(argv, index++, flag);
    else if (flag === "--target-writer-git-sha") args.targetWriterGitSha = requireValue(argv, index++, flag);
    else if (flag === "--writer-limits-json") args.writerLimitsPath = requireValue(argv, index++, flag);
    else if (flag === "--dropbox-root") args.dropboxRoot = requireValue(argv, index++, flag);
    else if (flag === "--expected-inventory-root-sha256") {
      args.expectedInventoryRootSha256 = requireValue(argv, index++, flag);
    } else if (flag === "--expected-state-root-sha256") {
      args.expectedStateRootSha256 = requireValue(argv, index++, flag);
    } else if (flag === "--report-out") args.reportOut = requireValue(argv, index++, flag);
    else if (flag === "--operator-authority-file") args.operatorAuthorityFile = requireValue(argv, index++, flag);
    else if (flag === "--v2-runtime-rollback-record") {
      args.v2RuntimeRollbackRecord = requireValue(argv, index++, flag);
    }
    else if (flag === "--publication-concurrency") {
      args.publicationConcurrency = parsePublicationConcurrency(requireValue(argv, index++, flag));
    }
    else if (flag === "--checkpoint-in") args.checkpointIn = requireValue(argv, index++, flag);
    else if (flag === "--checkpoint-out") args.checkpointOut = requireValue(argv, index++, flag);
    else if (flag === "--expected-plan-sha256") {
      args.expectedPlanSha256 = requireValue(argv, index++, flag);
    }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!MODES.has(args.mode)) throw new Error(`Unsupported --mode: ${args.mode}`);
  if (
    !args.help &&
    !new Set(["v2-to-v3", "v3-rebuild"]).has(String(args.transition || ""))
  ) {
    throw new Error("--transition must be explicitly set to v2-to-v3 or v3-rebuild");
  }
  if (args.apply && !new Set(["migrate", "rollback"]).has(args.mode)) {
    throw new Error("--apply is valid only with a mutation mode");
  }
  if (new Set(["migrate", "rollback"]).has(args.mode) && !args.apply) {
    throw new Error(`${args.mode} mode requires --apply`);
  }
  if (args.apply && !args.writersFrozen) {
    throw new Error("Mutation requires --writers-frozen");
  }
  if (args.mode === "migrate" && !args.checkpointOut) {
    throw new Error("migrate mode requires --checkpoint-out");
  }
  if (
    args.mode === "migrate" &&
    args.checkpointIn &&
    path.resolve(args.checkpointIn) !== path.resolve(args.checkpointOut)
  ) {
    throw new Error("migrate resume requires --checkpoint-in and --checkpoint-out to be the same path");
  }
  if (args.mode === "verify" && !args.checkpointIn) {
    throw new Error("verify mode requires --checkpoint-in");
  }
  if (new Set(["rollback-plan", "rollback"]).has(args.mode) && !args.checkpointIn) {
    throw new Error(`${args.mode} mode requires --checkpoint-in`);
  }
  if (args.mode === "rollback" && !args.v2RuntimeRollbackRecord) {
    throw new Error("rollback mode requires --v2-runtime-rollback-record");
  }
  if (!new Set(["plan", "runtime-recoverability"]).has(args.mode) && !String(args.expectedPlanSha256 || "").trim()) {
    throw new Error(`${args.mode} mode requires --expected-plan-sha256`);
  }
  return Object.freeze(args);
}

function readJsonFile(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${filePath}`, {
      cause: error,
    });
  }
}

function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, stableMigrationJson(value), { mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const RECOVERY_PROGRESS_SCHEMA_VERSION = 1;
const RECOVERY_IMPLEMENTATION_PATHS = Object.freeze([
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  "scripts/backup_r2/lib/observation_history_migration_v3.mjs",
  "scripts/index_v3_migration/index_v3_migration.sh",
  "scripts/index_v3_migration/recovery_journal_authority.mjs",
]);

function recoveryProgressPaths(checkpointPath) {
  const root = `${path.resolve(checkpointPath)}.recovery`;
  return Object.freeze({
    root,
    manifest: path.join(root, "manifest.json"),
    head: path.join(root, "head.json"),
    entries: path.join(root, "entries"),
  });
}

function recoveryEnvelope(kind, payload) {
  return {
    schema_version: RECOVERY_PROGRESS_SCHEMA_VERSION,
    kind,
    payload,
    payload_sha256: sha256Hex(stableMigrationJson(payload)),
  };
}

function readRecoveryEnvelope(filePath, expectedKind) {
  const envelope = readJsonFile(filePath, expectedKind);
  if (
    envelope?.schema_version !== RECOVERY_PROGRESS_SCHEMA_VERSION ||
    envelope?.kind !== expectedKind ||
    !envelope.payload ||
    envelope.payload_sha256 !== sha256Hex(stableMigrationJson(envelope.payload))
  ) {
    throw new Error(`Recovery evidence is invalid: ${filePath}`);
  }
  return envelope;
}

function recoveryImplementationIdentity(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const repositoryHead = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (repositoryHead.status !== 0 || !String(repositoryHead.stdout || "").trim()) {
    throw new Error("Current recovery repository HEAD is unavailable");
  }
  const files = RECOVERY_IMPLEMENTATION_PATHS.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`Recovery implementation file is missing: ${relativePath}`);
    }
    const body = fs.readFileSync(absolutePath);
    return {
      path: relativePath,
      byte_size: body.byteLength,
      sha256: sha256Hex(body),
    };
  });
  return Object.freeze({
    repository_head: String(repositoryHead.stdout).trim(),
    files: Object.freeze(files),
  });
}

function checkpointFileIdentity(checkpointPath) {
  const absolutePath = path.resolve(checkpointPath);
  const body = fs.readFileSync(absolutePath);
  return Object.freeze({
    path: absolutePath,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
  });
}

function recoveryManifestPayload({
  checkpointPath,
  checkpoint,
  repositoryRoot,
  recoveryImplementation = null,
}) {
  const plan = buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint });
  return Object.freeze({
    original_checkpoint: checkpointFileIdentity(checkpointPath),
    immutable_authority_sha256: checkpoint.authority_sha256,
    migration_run_id: plan.migration_run_id,
    transition: plan.transition,
    plan_sha256: plan.plan_sha256,
    target_writer_git_sha: plan.target_writer_git_sha,
    recovery_implementation:
      recoveryImplementation || recoveryImplementationIdentity(repositoryRoot),
  });
}

function applyRecoveryUpdates(checkpoint, updates) {
  for (const entry of updates.prepared_records || []) {
    if (!entry?.unit_id || !entry.record || entry.record.unit_id !== entry.unit_id) {
      throw new Error("Recovery prepared-record update is invalid");
    }
    if (checkpoint.prepared_units[entry.unit_id]) {
      throw new Error(`Recovery journal redefines prepared unit: ${entry.unit_id}`);
    }
    checkpoint.prepared_units[entry.unit_id] = entry.record;
  }
  for (const entry of updates.prepared_state_updates || []) {
    const record = checkpoint.prepared_units[entry?.unit_id];
    if (!record) throw new Error(`Recovery state references unknown unit: ${entry?.unit_id}`);
    if (entry.files_published === true) record.files_published = true;
    if (entry.remove_staging_refs === true) {
      record.target_file_intents = record.target_file_intents.map(
        ({ staging_ref: _stagingRef, ...intent }) => intent,
      );
    }
  }
  for (const entry of updates.completed_objects || []) {
    if (!entry?.key || !entry.evidence) {
      throw new Error("Recovery completed-object update is invalid");
    }
    const previous = checkpoint.completed_objects[entry.key];
    if (previous) {
      if (stableMigrationJson(previous) !== stableMigrationJson(entry.evidence)) {
        throw new Error(
          `Completed-object evidence changed for ${entry.key}; old=${JSON.stringify(previous)} new=${JSON.stringify(entry.evidence)}`,
        );
      }
      continue;
    }
    checkpoint.completed_objects[entry.key] = entry.evidence;
  }
  for (const unitId of updates.preparation_order_append || []) {
    if (!checkpoint.prepared_units[unitId] || checkpoint.preparation_order.includes(unitId)) {
      throw new Error(`Recovery preparation-order update is invalid: ${unitId}`);
    }
    checkpoint.preparation_order.push(unitId);
  }
  if (updates.final_state) {
    if (typeof updates.final_state.full_verification_complete === "boolean") {
      checkpoint.full_verification_complete = updates.final_state.full_verification_complete;
    }
    if (typeof updates.final_state.cutover_ready === "boolean") {
      checkpoint.cutover_ready = updates.final_state.cutover_ready;
    }
  }
}

function replayRecoveryJournal({ paths, checkpoint, manifest, repairHead = false, diagnostics = false }) {
  fs.mkdirSync(paths.entries, { recursive: true, mode: 0o700 });
  const names = fs.readdirSync(paths.entries)
    .sort();
  if (!fs.existsSync(paths.head) && repairHead && names.length === 0) {
    atomicWriteJson(paths.head, recoveryEnvelope(
      "uk_aq_observation_history_v3_recovery_head",
      {
        original_checkpoint_sha256: manifest.payload.original_checkpoint.sha256,
        immutable_authority_sha256: manifest.payload.immutable_authority_sha256,
        last_sequence: 0,
        last_entry_sha256: null,
      },
    ));
  }
  const authenticationStartedAt = Date.now();
  const authenticationProgress = createOperatorProgress({ label: "V3 recovery: authenticating historical journal", enabled: diagnostics || Boolean(process.env.UK_AQ_OPERATOR_RUN_DIR) });
  if (diagnostics) process.stderr.write(`V3 recovery: authenticating ${names.length} journal entries start=${new Date(authenticationStartedAt).toISOString()}\n`);
  const replay = readAndValidateRecoveryJournal({
    recoveryRoot: paths.root,
    expectedCheckpointSha256: manifest.payload.original_checkpoint.sha256,
    expectedCheckpointByteSize: manifest.payload.original_checkpoint.byte_size,
    expectedAuthoritySha256: manifest.payload.immutable_authority_sha256,
    expectedMigrationRunId: manifest.payload.migration_run_id,
    expectedPlanSha256: manifest.payload.plan_sha256,
    expectedTargetWriterGitSha: manifest.payload.target_writer_git_sha,
    allowEmpty: true,
  });
  authenticationProgress.finish();
  if (diagnostics) process.stderr.write(`V3 recovery: authentication complete entries=${replay.entries.length} elapsed_ms=${Date.now() - authenticationStartedAt}\n`);
  const replayProgress = createMigrationProgressReporter({
    label: "V3 recovery: applying authenticated journal", total: replay.entries.length, enabled: diagnostics,
  });
  replayProgress.report(0, { force: true });
  const publicationEvidence = [];
  for (const [index, entry] of replay.entries.entries()) {
    const payload = entry.payload;
    applyRecoveryUpdates(checkpoint, payload.updates || {});
    publicationEvidence.push(...(payload.updates?.publication_evidence || []));
    replayProgress.report(index + 1);
  }
  if (diagnostics) process.stderr.write(`V3 recovery: replay complete entries=${replay.entries.length} elapsed_ms=${Date.now() - authenticationStartedAt}\n`);
  return {
    sequence: replay.last_sequence,
    entrySha256: replay.last_entry_sha256,
    publicationEvidence,
  };
}

function preparedProgressState(checkpoint) {
  return new Map(Object.entries(checkpoint.prepared_units || {}).map(([unitId, record]) => [
    unitId,
    {
      prepared_plan_sha256: record.prepared_plan_sha256,
      files_published: record.files_published === true,
      staging_ref_count: (record.target_file_intents || []).filter(
        (intent) => Boolean(intent.staging_ref),
      ).length,
    },
  ]));
}

function appendRecoveryJournalEntry(context, updates) {
  const sequence = context.sequence + 1;
  const payload = {
    sequence,
    previous_entry_sha256: context.entrySha256,
    original_checkpoint_sha256: context.manifest.payload.original_checkpoint.sha256,
    immutable_authority_sha256: context.manifest.payload.immutable_authority_sha256,
    updates,
  };
  const envelope = recoveryEnvelope(
    "uk_aq_observation_history_v3_recovery_entry",
    payload,
  );
  const target = path.join(context.paths.entries, `${String(sequence).padStart(10, "0")}.json`);
  if (fs.existsSync(target)) throw new Error(`Recovery journal entry already exists: ${target}`);
  atomicWriteJson(target, envelope);
  const headPayload = {
    original_checkpoint_sha256: context.manifest.payload.original_checkpoint.sha256,
    immutable_authority_sha256: context.manifest.payload.immutable_authority_sha256,
    last_sequence: sequence,
    last_entry_sha256: envelope.payload_sha256,
  };
  atomicWriteJson(context.paths.head, recoveryEnvelope(
    "uk_aq_observation_history_v3_recovery_head",
    headPayload,
  ));
  context.sequence = sequence;
  context.entrySha256 = envelope.payload_sha256;
}

export function buildObservationHistoryV3RecoveryProgressContext({
  checkpointPath,
  checkpoint,
  repositoryRoot,
  create = false,
  repairHead = false,
  requireCurrentImplementation = true,
  diagnostics = false,
}) {
  if (diagnostics) process.stderr.write("V3 recovery: authenticating original checkpoint and recovery manifest\n");
  const paths = recoveryProgressPaths(checkpointPath);
  let createdManifest = false;
  if (!fs.existsSync(paths.manifest)) {
    if (!create) throw new Error("Recovery progress manifest is missing; run resume preflight first");
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    atomicWriteJson(paths.manifest, recoveryEnvelope(
      "uk_aq_observation_history_v3_recovery_manifest",
      recoveryManifestPayload({ checkpointPath, checkpoint, repositoryRoot }),
    ));
    createdManifest = true;
  }
  const manifest = readRecoveryEnvelope(
    paths.manifest,
    "uk_aq_observation_history_v3_recovery_manifest",
  );
  const expectedManifestPayload = recoveryManifestPayload({
    checkpointPath,
    checkpoint,
    repositoryRoot,
    recoveryImplementation: requireCurrentImplementation
      ? null
      : manifest.payload.recovery_implementation,
  });
  if (stableMigrationJson(manifest.payload) !== stableMigrationJson(expectedManifestPayload)) {
    throw new Error("Recovery manifest does not match the original checkpoint or current recovery code");
  }
  const recoveredCheckpoint = structuredClone(checkpoint);
  const replay = replayRecoveryJournal({
    paths,
    checkpoint: recoveredCheckpoint,
    manifest,
    repairHead: repairHead || createdManifest,
    diagnostics,
  });
  if (diagnostics) {
    process.stderr.write(`V3 recovery: authenticated entries=${replay.sequence} prepared_units=${
      Object.keys(recoveredCheckpoint.prepared_units || {}).length
    } completed_objects=${Object.keys(recoveredCheckpoint.completed_objects || {}).length} v3_publication_evidence=${
      replay.publicationEvidence.length
    }\n`);
  }
  buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint: recoveredCheckpoint });
  const context = {
    paths,
    manifest,
    checkpoint: recoveredCheckpoint,
    sequence: replay.sequence,
    entrySha256: replay.entrySha256,
    publicationEvidence: replay.publicationEvidence,
    preparedState: preparedProgressState(recoveredCheckpoint),
    completedEvidence: new Map(
      Object.entries(recoveredCheckpoint.completed_objects || {}).map(
        ([key, evidence]) => [key, structuredClone(evidence)],
      ),
    ),
    preparationOrder: [...(recoveredCheckpoint.preparation_order || [])],
    fullVerificationComplete: recoveredCheckpoint.full_verification_complete === true,
    cutoverReady: recoveredCheckpoint.cutover_ready === true,
    authenticatedRecoveryAuthority: Object.freeze({
      authenticated: true,
      original_checkpoint_sha256: manifest.payload.original_checkpoint.sha256,
      immutable_authority_sha256: manifest.payload.immutable_authority_sha256,
      migration_run_id: manifest.payload.migration_run_id,
      plan_sha256: manifest.payload.plan_sha256,
      last_sequence: replay.sequence,
      last_entry_sha256: replay.entrySha256,
      replayed_checkpoint_sha256:
        buildObservationHistoryV3RecoveryReplayStateSha256(recoveredCheckpoint),
    }),
  };
  context.persistCheckpoint = async (current) => {
    const updates = {};
    const preparedRecords = [];
    const preparedStateUpdates = [];
    for (const [unitId, record] of Object.entries(current.prepared_units || {})) {
      const previous = context.preparedState.get(unitId);
      const next = preparedProgressState({ prepared_units: { [unitId]: record } }).get(unitId);
      if (!previous) {
        preparedRecords.push({ unit_id: unitId, record });
      } else {
        if (previous.prepared_plan_sha256 !== next.prepared_plan_sha256) {
          throw new Error(`Prepared recovery identity changed: ${unitId}`);
        }
        const stateUpdate = { unit_id: unitId };
        let changed = false;
        if (!previous.files_published && next.files_published) {
          stateUpdate.files_published = true;
          changed = true;
        } else if (previous.files_published !== next.files_published) {
          throw new Error(`Prepared publication state regressed: ${unitId}`);
        }
        if (previous.staging_ref_count > 0 && next.staging_ref_count === 0) {
          stateUpdate.remove_staging_refs = true;
          changed = true;
        } else if (previous.staging_ref_count !== next.staging_ref_count) {
          throw new Error(`Prepared staging state changed unexpectedly: ${unitId}`);
        }
        if (changed) preparedStateUpdates.push(stateUpdate);
      }
    }
    if (preparedRecords.length) updates.prepared_records = preparedRecords;
    if (preparedStateUpdates.length) updates.prepared_state_updates = preparedStateUpdates;
    const completedObjects = [];
    for (const [key, evidence] of Object.entries(current.completed_objects || {})) {
      const previous = context.completedEvidence.get(key);
      if (!previous) {
        completedObjects.push({ key, evidence });
      } else if (stableMigrationJson(previous) !== stableMigrationJson(evidence)) {
        throw new Error(
          `Completed-object evidence changed for ${key}; old=${JSON.stringify(previous)} new=${JSON.stringify(evidence)}`,
        );
      }
    }
    for (const key of context.completedEvidence.keys()) {
      if (!Object.hasOwn(current.completed_objects || {}, key)) {
        throw new Error(`Completed-object evidence was removed: ${key}`);
      }
    }
    if (completedObjects.length) updates.completed_objects = completedObjects;
    const currentOrder = current.preparation_order || [];
    if (
      context.preparationOrder.some((unitId, index) => currentOrder[index] !== unitId) ||
      currentOrder.length < context.preparationOrder.length
    ) {
      throw new Error("Recovery preparation order changed or regressed");
    }
    const orderAppend = currentOrder.slice(context.preparationOrder.length);
    if (orderAppend.length) updates.preparation_order_append = orderAppend;
    if (
      context.fullVerificationComplete !== (current.full_verification_complete === true) ||
      context.cutoverReady !== (current.cutover_ready === true)
    ) {
      updates.final_state = {
        full_verification_complete: current.full_verification_complete === true,
        cutover_ready: current.cutover_ready === true,
      };
    }
    if (!Object.keys(updates).length) return;
    appendRecoveryJournalEntry(context, updates);
    context.preparedState = preparedProgressState(current);
    context.completedEvidence = new Map(
      Object.entries(current.completed_objects || {}).map(
        ([key, evidence]) => [key, structuredClone(evidence)],
      ),
    );
    context.preparationOrder = [...currentOrder];
    context.fullVerificationComplete = current.full_verification_complete === true;
    context.cutoverReady = current.cutover_ready === true;
  };
  context.recordPublicationEvidenceBatch = async (entries) => {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 16) {
      throw new Error("Recovery publication evidence batch must contain 1..16 entries");
    }
    const ordered = entries.map((entry) => ({ ...entry }));
    if (ordered.some((entry, index) => index > 0 && entry.position <= ordered[index - 1].position)) {
      throw new Error("Recovery publication evidence batch is not in publication-plan order");
    }
    appendRecoveryJournalEntry(context, { publication_evidence: ordered });
    context.publicationEvidence.push(...ordered);
    return { durable: true };
  };
  context.recordPublicationEvidence = (entry) => context.recordPublicationEvidenceBatch([entry]);
  return context;
}

export function initializeObservationHistoryV3RecoveryProgress({
  checkpointPath,
  repositoryRoot,
  retainedStagingRoot = `${path.resolve(checkpointPath)}.staging`,
} = {}) {
  const checkpoint = readJsonFile(checkpointPath, "migration checkpoint");
  const context = buildObservationHistoryV3RecoveryProgressContext({
    checkpointPath,
    checkpoint,
    repositoryRoot,
    create: true,
    repairHead: true,
  });
  const stagingRoot = path.resolve(retainedStagingRoot);
  let retainedStagingFiles = 0;
  for (const record of Object.values(context.checkpoint.prepared_units || {})) {
    for (const intent of record.target_file_intents || []) {
      if (!intent.staging_ref) continue;
      const stagingRef = path.resolve(intent.staging_ref);
      if (stagingRef !== stagingRoot && !stagingRef.startsWith(`${stagingRoot}${path.sep}`)) {
        throw new Error(`Retained staging reference escapes the recovery root: ${intent.key}`);
      }
      if (record.files_published !== true) {
        const body = fs.readFileSync(stagingRef);
        if (body.byteLength !== intent.byte_size || sha256Hex(body) !== intent.sha256) {
          throw new Error(`Retained staging identity is invalid: ${intent.key}`);
        }
      }
      retainedStagingFiles += 1;
    }
  }
  return Object.freeze({
    recovery_root: context.paths.root,
    original_checkpoint: context.manifest.payload.original_checkpoint,
    immutable_authority_sha256: context.manifest.payload.immutable_authority_sha256,
    migration_run_id: context.manifest.payload.migration_run_id,
    plan_sha256: context.manifest.payload.plan_sha256,
    target_writer_git_sha: context.manifest.payload.target_writer_git_sha,
    recovery_implementation: context.manifest.payload.recovery_implementation,
    journal_entries: context.sequence,
    prepared_units: Object.keys(context.checkpoint.prepared_units || {}).length,
    completed_objects: Object.keys(context.checkpoint.completed_objects || {}).length,
    retained_staging_files: retainedStagingFiles,
  });
}

function isRcloneRemote(value) {
  return /^[A-Za-z0-9_.-]+:/.test(String(value || ""));
}

export function buildDropboxBackupReader(dropboxRoot) {
  const root = String(dropboxRoot || "").trim().replace(/\/+$/, "");
  if (!root) throw new Error("--dropbox-root is required");
  if (isRcloneRemote(root)) {
    return async ({ key }) => {
      const target = `${root}/${String(key).replace(/^\/+/, "")}`;
      const result = spawnSync("rclone", ["cat", target], {
        encoding: null,
        maxBuffer: 2_147_483_647,
      });
      if (result.status !== 0) {
        throw new Error(
          `Dropbox rclone read failed: ${key}: ${Buffer.from(result.stderr || "").toString("utf8").trim()}`,
        );
      }
      return { exists: true, body: Buffer.from(result.stdout) };
    };
  }
  const localRoot = path.resolve(root);
  return async ({ key }) => {
    const target = path.resolve(localRoot, String(key).replace(/^\/+/, ""));
    if (target !== localRoot && !target.startsWith(`${localRoot}${path.sep}`)) {
      throw new Error(`Dropbox backup key escapes the selected root: ${key}`);
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return { exists: false, body: null };
    }
    return { exists: true, body: fs.readFileSync(target) };
  };
}

function requireCommonArgs(args) {
  const missing = [
    ["--transition", args.transition],
    ["--environment", args.environment],
    ["--expected-bucket", args.expectedBucket],
    ["--migration-run-id", args.migrationRunId],
    ["--target-writer-git-sha", args.targetWriterGitSha],
    ["--writer-limits-json", args.writerLimitsPath],
    ["--dropbox-root", args.dropboxRoot],
    ["--expected-inventory-root-sha256", args.expectedInventoryRootSha256],
    ["--expected-state-root-sha256", args.expectedStateRootSha256],
    ["--report-out", args.reportOut],
  ].filter(([, value]) => !String(value || "").trim());
  if (missing.length) throw new Error(`Missing required arguments: ${missing.map(([flag]) => flag).join(", ")}`);
}

function environmentEvidence(args, env, config) {
  return {
    transition: args.transition,
    environment: args.environment,
    configuredEnvironment: env.UK_AQ_ENV_NAME || env.ENVIRONMENT || "",
    bucket: config.r2.bucket,
    expectedBucket: args.expectedBucket,
    historyVersion: env.UK_AQ_R2_HISTORY_VERSION || "",
    indexVersion: env.UK_AQ_R2_HISTORY_INDEX_VERSION || "",
    integrityVersion: env.UK_AQ_R2_HISTORY_INTEGRITY_VERSION || "",
  };
}

function summaryForPlan(plan) {
  const identity = (entry) => entry
    ? {
        key: entry.key,
        byte_size: entry.byte_size,
        sha256: entry.sha256,
      }
    : null;
  return {
    schema_version: plan.schema_version,
    kind: "uk_aq_observation_history_v3_migration_plan_summary",
    migration_run_id: plan.migration_run_id,
    transition: plan.transition,
    plan_sha256: plan.plan_sha256,
    environment: plan.environment,
    target: plan.target,
    source_root: {
      ...identity(plan.inventory.root_manifest),
      content_hash: plan.inventory.root_manifest.payload.content_hash,
    },
    backup_gate: plan.backup_gate
      ? {
          verified: plan.backup_gate.verified,
          inventory_root: identity(plan.backup_gate.inventory_root),
          state_root: identity(plan.backup_gate.state_root),
        }
      : null,
    estimated: plan.estimated,
    source_observation_content_hash_provenance_counts:
      plan.source_observation_content_hash_provenance_counts,
    source_manifest_reference_provenance_counts:
      plan.source_manifest_reference_provenance_counts,
    empty_source_connector_count: plan.empty_source_connector_count,
    empty_source_connectors: plan.empty_source_connectors.map((entry) => ({
      scope: entry.scope,
      source_manifest_key: entry.source_manifest_key,
      source_manifest_identity: entry.source_manifest_identity,
      source_manifest_hash: entry.source_manifest_hash,
      classification: entry.classification,
      contract_version: entry.contract_version,
    })),
    writer_freeze_plan: plan.writer_freeze_plan,
    partitions: plan.units.map((unit) => ({
      unit_id: unit.unit_id,
      scope: unit.scope,
      source_manifest_identity: unit.source_manifest_identity,
      source_files: unit.source_files,
      source_row_count: unit.source_row_count,
      source_observation_content_hash: unit.source_observation_content_hash,
      source_observation_content_hash_provenance:
        unit.source_observation_content_hash_provenance,
      source_manifest_reference_provenance:
        unit.source_manifest_reference.provenance,
      source_current_child_genuine_legacy_hashless:
        unit.source_manifest_reference.current_child_genuine_legacy_hashless,
      source_parent_referenced_child_manifest_hash:
        unit.source_manifest_reference.referenced_child_manifest_hash,
      source_current_child_manifest_hash:
        unit.source_manifest_reference.current_child_manifest_hash,
      source_manifest_reference_compatibility_contract_version:
        unit.source_manifest_reference.compatibility_contract_version,
      source_manifest_reference_summary_identity_all_match:
        unit.source_manifest_reference.summary_identity_all_match,
      source_manifest_reference_summary_identity_fields:
        unit.source_manifest_reference.compatibility_summary_identity_fields,
      source_verification_status_counts: unit.source_verification_status_counts,
      target_file_count: unit.target_file_count,
      target_row_group_count: unit.target_row_group_count,
    })),
    rollback_inputs: plan.backup_gate
      ? {
          inventory_root: plan.backup_gate.inventory_root.key,
          state_root: plan.backup_gate.state_root.key,
          month_inventory_shards: plan.backup_gate.month_inventory_shards.map((entry) => entry.key),
          month_state_shards: plan.backup_gate.month_state_shards.map((entry) => entry.key),
        }
      : null,
    rollback_preflight: plan.rollback_preflight,
    blockers: plan.blockers,
    mutation_allowed: plan.mutation_allowed,
  };
}

const REPORT_LIST_LIMIT = 100;
const REPORT_STRING_LIMIT = 2_000;

function compactReportString(value) {
  const text = String(value);
  if (text.length <= REPORT_STRING_LIMIT) return text;
  return `${text.slice(0, REPORT_STRING_LIMIT)}...[truncated]`;
}

function boundedReportList(values) {
  const entries = Array.isArray(values) ? values : [];
  return {
    entries: entries.slice(0, REPORT_LIST_LIMIT),
    total_count: entries.length,
    omitted_count: Math.max(0, entries.length - REPORT_LIST_LIMIT),
  };
}

function compactVerificationReport(verification) {
  if (!verification) return null;
  const blockers = boundedReportList(
    (verification.blockers || []).map(compactReportString),
  );
  return {
    ok: verification.ok,
    cutover_ready: verification.cutover_ready,
    blockers: blockers.entries,
    blocker_count: blockers.total_count,
    blockers_omitted: blockers.omitted_count,
    partition_count: verification.partition_count,
    v3_child_count: verification.v3_child_count,
    v3_scoped_root_count: verification.v3_scoped_root_count,
    v3_latest_count: verification.v3_latest_count,
    r2_stored_sha_verification: verification.r2_stored_sha_verification,
    scoped_root_child_verification:
      verification.scoped_root_child_verification,
    failure_category: verification.failure_category || null,
    recovery_reconciliation: verification.recovery_reconciliation
      ? {
          mode: verification.recovery_reconciliation.mode,
          counts: verification.recovery_reconciliation.counts,
        }
      : null,
  };
}

function migrationVerificationFailureCategory(message) {
  for (const category of [
    "recovery_evidence_invalid",
    "reconstructed_target_mismatch",
    "r2_exact_mismatch",
    "legacy_reconciliation_failed",
  ]) {
    if (String(message).includes(category)) return category;
  }
  return "verification_failed_before_r2_comparison";
}

function sumReportField(entries, field) {
  return entries.reduce((total, entry) => {
    const value = entry?.[field];
    return Number.isSafeInteger(value) && value >= 0 ? total + value : total;
  }, 0);
}

function partitionResultSummary(partitions) {
  const entries = Array.isArray(partitions) ? partitions : [];
  const verificationStatusCounts = {};
  for (const entry of entries) {
    for (const [status, count] of Object.entries(
      entry?.verification_status_counts || {},
    )) {
      if (Number.isSafeInteger(count) && count >= 0) {
        verificationStatusCounts[status] =
          (verificationStatusCounts[status] || 0) + count;
      }
    }
  }
  return {
    partition_count: entries.length,
    row_count_match_count: entries.filter(
      (entry) => entry.old_row_count === entry.new_row_count,
    ).length,
    observation_content_hash_match_count: entries.filter(
      (entry) =>
        entry.old_observation_content_hash === entry.new_observation_content_hash,
    ).length,
    old_row_count_total: sumReportField(entries, "old_row_count"),
    new_row_count_total: sumReportField(entries, "new_row_count"),
    old_file_count_total: sumReportField(entries, "old_file_count"),
    new_file_count_total: sumReportField(entries, "new_file_count"),
    new_row_group_count_total: sumReportField(entries, "new_row_group_count"),
    verification_status_counts: verificationStatusCounts,
    partition_details_excluded: true,
  };
}

function completedObjectCounts(checkpoint) {
  const counts = {
    parquet: 0,
    canonical_manifest: 0,
    v3_child_shard: 0,
    v3_scoped_manifest: 0,
    v3_latest_global: 0,
    other: 0,
  };
  const completed = Object.entries(checkpoint?.completed_objects || {});
  const canonicalManifestPrefix = `${DEFAULT_OBSERVATIONS_PREFIX}/`;
  const v3ScopedPrefix = `${DEFAULT_V3_INDEX_ROOT}/`;
  for (const [key] of completed) {
    if (key.endsWith(".parquet")) counts.parquet += 1;
    else if (key === DEFAULT_V3_LATEST_KEY) counts.v3_latest_global += 1;
    else if (
      key.startsWith(v3ScopedPrefix) &&
      /\/range=\d+-\d+\.json$/.test(key)
    ) counts.v3_child_shard += 1;
    else if (
      key.startsWith(v3ScopedPrefix) &&
      key.endsWith("/manifest.json")
    ) counts.v3_scoped_manifest += 1;
    else if (
      key.startsWith(canonicalManifestPrefix) &&
      key.endsWith("/manifest.json")
    ) counts.canonical_manifest += 1;
    else counts.other += 1;
  }
  return {
    total: completed.length,
    ...counts,
  };
}

function parquetEvidenceSummary(parquetEvidence) {
  const entries = Array.isArray(parquetEvidence) ? parquetEvidence : [];
  return {
    object_count: entries.length,
    total_bytes: sumReportField(entries, "byte_size"),
    stored_sha256_verified_count: entries.filter(
      (entry) => entry.stored_sha256_verified === true,
    ).length,
    reused_count: entries.filter((entry) => entry.reused === true).length,
    published_count: entries.filter((entry) => entry.reused !== true).length,
    object_details_excluded: true,
  };
}

function v3PublicationSummary(publication) {
  if (!publication) return null;
  const objects = Array.isArray(publication.objects) ? publication.objects : [];
  const publicationStageCounts = {};
  for (const entry of objects) {
    const stage = String(entry?.publication_stage || "unknown");
    publicationStageCounts[stage] = (publicationStageCounts[stage] || 0) + 1;
  }
  return {
    ok: publication.ok,
    status: publication.status,
    schedule_sha256: publication.schedule_sha256,
    published_object_count: publication.published_object_count,
    publication_stage_counts: publicationStageCounts,
    verified_object_count: objects.filter((entry) => entry.verified === true).length,
    durable_object_count: objects.filter((entry) => entry.durable === true).length,
    object_details_excluded: true,
  };
}

function checkpointSummary(checkpoint) {
  if (!checkpoint) return null;
  return {
    migration_run_id: checkpoint.migration_run_id,
    authority_sha256: checkpoint.authority_sha256,
    plan_sha256: checkpoint.plan_sha256,
    full_verification_complete: checkpoint.full_verification_complete === true,
    cutover_ready: checkpoint.cutover_ready === true,
    prepared_unit_count: Object.keys(checkpoint.prepared_units || {}).length,
    completed_object_count: Object.keys(checkpoint.completed_objects || {}).length,
    completed_object_counts: completedObjectCounts(checkpoint),
    checkpoint_details_excluded: true,
  };
}

function compactMigrationResult(result, mode, checkpoint) {
  if (mode === "verify") {
    return {
      ...compactVerificationReport(result),
      checkpoint_summary: checkpointSummary(checkpoint),
    };
  }
  if (result?.ok === false) {
    return {
      ok: false,
      status: result.status,
      error: compactReportString(result.error || "operation failed"),
      runtime_recoverability: result.runtime_recoverability || null,
      runtime_recovery: result.runtime_recovery || null,
      verification: compactVerificationReport(result.verification),
      checkpoint_summary: checkpointSummary(checkpoint),
    };
  }
  if (mode === "migrate") {
    return {
      ok: result?.ok,
      status: result?.status,
      dry_run: result?.dry_run,
      checkpoint_summary: checkpointSummary(result?.checkpoint || checkpoint),
      parquet_evidence_summary: parquetEvidenceSummary(result?.parquet_evidence),
      v3_publication: v3PublicationSummary(result?.v3_publication),
      verification: compactVerificationReport(result?.verification),
    };
  }
  return result;
}

function compactMigrationAudit(audit) {
  const {
    partition_results: partitionResults = [],
    empty_source_connectors: emptySourceConnectors = [],
    blockers: rawBlockers = [],
    ...compact
  } = audit;
  const emptyConnectors = boundedReportList(emptySourceConnectors);
  const blockers = boundedReportList(rawBlockers.map(compactReportString));
  return {
    ...compact,
    empty_source_connectors: emptyConnectors.entries,
    empty_source_connectors_omitted: emptyConnectors.omitted_count,
    partition_result_summary: partitionResultSummary(partitionResults),
    blockers: blockers.entries,
    blocker_count: blockers.total_count,
    blockers_omitted: blockers.omitted_count,
  };
}

export function buildObservationHistoryV3ReportOutput({
  result,
  audit,
  mode,
  checkpoint = null,
}) {
  return {
    result: compactMigrationResult(result, mode, checkpoint),
    audit: compactMigrationAudit(audit),
  };
}

async function runRollbackCommand(command, args, options) {
  const result = await runOperatorCommand(command, args, options);
  return Object.freeze({ ok: true, label: options.label, ...result });
}

function rollbackComponent(payload, role) {
  const matches = (payload?.components || []).filter((entry) => entry?.role === role);
  if (matches.length !== 1) throw new Error(`Pinned v2 runtime component is invalid: ${role}`);
  return matches[0];
}

async function cloudflareWorkerApiGet({ accountId, apiToken, workerName, suffix, allowMissingVersion = false }) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
      `/workers/scripts/${encodeURIComponent(workerName)}/${suffix}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
    },
  );
  const document = await response.json().catch(() => null);
  if (allowMissingVersion && response.status === 404 &&
      document?.errors?.some(error => Number(error.code) === 100146)) return null;
  if (!response.ok || document?.success !== true) {
    throw new Error(
      `Read-only Cloudflare Worker verification failed for ${workerName} with HTTP ${response.status}`,
    );
  }
  return document.result;
}

function currentFullDeploymentForVersion(result, versionId, label) {
  const deployments = Array.isArray(result) ? result : result?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(`${label} deployment history is missing`);
  }
  const ordered = deployments.map((deployment) => {
    const createdAt = Date.parse(String(deployment?.created_on || ""));
    if (!Number.isFinite(createdAt)) {
      throw new Error(`${label} deployment timestamp is invalid`);
    }
    return { deployment, createdAt };
  }).sort((left, right) => right.createdAt - left.createdAt);
  if (ordered.length > 1 && ordered[0].createdAt === ordered[1].createdAt) {
    throw new Error(`${label} current deployment chronology is ambiguous`);
  }
  const current = ordered[0].deployment;
  const versions = Array.isArray(current?.versions) ? current.versions : [];
  if (
    versions.length !== 1 ||
    versions[0]?.version_id !== versionId ||
    Number(versions[0]?.percentage) !== 100
  ) {
    throw new Error(`${label} current deployment is not the pinned v2 version at 100%`);
  }
  return current;
}

function serviceBindingTarget(versionDetail, bindingName, label) {
  const bindings = (versionDetail?.resources?.bindings || []).filter((binding) =>
    binding?.type === "service" && binding?.name === bindingName
  );
  if (bindings.length !== 1 || typeof bindings[0]?.service !== "string") {
    throw new Error(`${label} does not contain one ${bindingName} Service Binding`);
  }
  return bindings[0].service;
}

export function v2RuntimeAuthorityAdapters({ rollbackEvidence, repositoryRoot, env, apiGet = cloudflareWorkerApiGet, command = runRollbackCommand, apiRequest = workerRuntimeRequest }) {
  const durable = rollbackEvidence.schema_version === 2;
  if (durable) validateDurableRuntimeEvidence(rollbackEvidence, repositoryRoot);
  const payload = rollbackEvidence.payload;
  const observations = rollbackComponent(payload, "stable_observations_worker");
  const station = rollbackComponent(payload, "stable_station_worker");
  const cache = rollbackComponent(payload, "cache_worker");
  const cacheVersionId = durable ? cache.deployment.version_id : payload.cache_provenance.pre_cutover_v2_cache_runtime.version_id;
  const durableCredentials = durable ? cloudflareCaptureCredentials(env) : null;
  const accountId = durable ? durableCredentials.domain.accountId : String(env.UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID || "").trim();
  const apiToken = durable ? durableCredentials.domain.apiToken : String(env.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN || "").trim();
  if (!accountId || !apiToken) {
    throw new Error(
      "Rollback requires UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID and UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN before canonical restoration",
    );
  }
  const childEnvironment = { ...process.env, ...env };
  childEnvironment.CLOUDFLARE_ACCOUNT_ID = accountId;
  childEnvironment.CLOUDFLARE_API_TOKEN = apiToken;
  const components = [observations, station, cache];
  let admission = null;
  let dispositions = null;
  const auth = component => {
    const selectedAccount = durable && component.role === "stable_observations_worker" ? durableCredentials.observations.accountId : accountId;
    const selectedToken = durable && component.role === "stable_observations_worker" ? durableCredentials.observations.apiToken : apiToken;
    if (!selectedAccount || !selectedToken || (durable && selectedAccount !== component.account_id)) throw new Error("Pinned runtime Cloudflare account/credentials mismatch");
    return {accountId:selectedAccount, apiToken:selectedToken, workerName:component.worker_name};
  };
  const get = (component, suffix, options = {}) => apiGet({ ...auth(component), suffix, ...options });
  const request = (component, suffix, options) => apiRequest({...auth(component),suffix,...options});
  const inspect = async () => {
    const recoverability = [];
    for (const component of components) {
      const versionId = component.deployment.version_id;
      const deployments = await get(component, "deployments");
      // A timestamp orders deployment records only; it never establishes code equivalence.
      let currentExact = false;
      try { currentFullDeploymentForVersion(deployments, versionId, component.role); currentExact = true; }
      catch { /* A non-exact current deployment must use an independently available pinned version. */ }
      const detail = await get(component, `versions/${encodeURIComponent(versionId)}`, { allowMissingVersion: true });
      if (detail !== null && detail?.id !== versionId) throw new Error(`Pinned runtime version response identity mismatch: ${component.role}`);
      if (component.role === "cache_worker" && detail &&
          serviceBindingTarget(detail, "STATION_HISTORY", "Pinned cache runtime") !== station.worker_name) {
        throw new Error("Pinned cache runtime does not select the stable station-history Worker");
      }
      // The legacy observations/station record has no resolved runtime/bundle
      // descriptor. Git templates + dates cannot authorize another UUID or a
      // rebuild using today's substitutions/secrets/toolchain. Cache descriptor
      // equality also cannot prove opaque secret-value identity across versions.
      if (durable && detail && runtimeJson(runtimeDescriptor(detail)) !== runtimeJson(readRuntimePackage(component, repositoryRoot).descriptor)) throw new Error("Pinned runtime descriptor differs from durable authority");
      let artifactAvailable = false;
      let artifactFailure = null;
      if (durable && !detail) {
        try { await inspectArtifactRecovery({component, repositoryRoot, get}); artifactAvailable = true; }
        catch (error) { artifactFailure = error.message; }
      }
      const viable = !durable && (component.role !== "cache_worker" || detail !== null) || detail !== null;
      const state = currentExact && viable ? "already_exact_pinned_version"
        : detail ? "pinned_version_available_for_deploy" : artifactAvailable ? "deterministic_pinned_runtime_redeploy_available" : "unrecoverable";
      recoverability.push(Object.freeze({
        role: component.role, worker_name: component.worker_name,
        pinned_git_commit_sha: component.git_commit_sha,
        historical_version_id: versionId,
        selected_version_id: state === "unrecoverable" || artifactAvailable ? null : versionId,
        state,
        reason: state === "unrecoverable"
          ? artifactFailure || "Pinned Cloudflare version unavailable; no durable exact deployed bundle, resolved configuration/binding/secret identity and reproducible build provenance authorizes a replacement runtime. Stable name, timestamps and nearby workflow runs are insufficient."
          : artifactAvailable ? "Pinned physical module bytes and resolved configuration; explicit current-required-secret-binding policy" : "Exact immutable Cloudflare version identity",
      }));
    }
    return Object.freeze({ ok: recoverability.every(entry => entry.state !== "unrecoverable"), components: Object.freeze(recoverability), evidence_payload_sha256: rollbackEvidence.payload_sha256 });
  };
  const checkV2RuntimeRecoverability = async () => withOperatorPhase("Rollback: runtime recoverability admission", async () => {
    admission = null; // A failed re-check must never retain a prior admission.
    admission = await inspect();
    for (const entry of admission.components) {
      try { process.stderr.write(`Runtime recovery: ${entry.role} ${entry.state} version=${entry.historical_version_id}\n`); } catch { /* diagnostic only */ }
    }
    if (!admission.ok) {
      const error = new Error(`Rollback runtime unrecoverable before canonical mutation: ${admission.components.filter(entry => entry.state === "unrecoverable").map(entry => `${entry.worker_name}: ${entry.reason}`).join("; ")}`);
      error.runtimeRecoverability = admission;
      throw error;
    }
    return admission;
  });
  return Object.freeze({
    checkV2RuntimeRecoverability,
    getV2RuntimeRecoveryEvidence: () => ({
      admission,
      components: (admission?.components || []).map(selected =>
        dispositions?.find(entry => entry.role === selected.role) ||
        { ...selected, disposition: "not_restored" }),
    }),
    restoreV2RuntimeAuthority: async () => {
      if (!admission?.ok) throw new Error("Runtime restoration requires successful pre-mutation recoverability admission");
      dispositions = [];
      const restore = async component => {
        let selected = admission.components.find(entry => entry.role === component.role);
        const artifactRoute = selected.state === "deterministic_pinned_runtime_redeploy_available";
        if (artifactRoute) {
          const version = await uploadPinnedRuntime({component, repositoryRoot, get, request});
          selected = {...selected, selected_version_id:version};
        }
        // Re-check before retaining a version; admission is not a stale-state shortcut.
        const current = await get(component, "deployments");
        let exact = false;
        try { currentFullDeploymentForVersion(current, selected.selected_version_id, component.role); exact = true; } catch { /* deploy only selected authority */ }
        if (!exact && durable) await request(component, "deployments", {method:"POST",body:JSON.stringify({strategy:"percentage",versions:[{version_id:selected.selected_version_id,percentage:100}]})});
        if (!exact && !durable) await command("npx", ["wrangler", "versions", "deploy", `${selected.selected_version_id}@100%`, "--name", component.worker_name, "-y"], {
          cwd: repositoryRoot, env: childEnvironment, label: `Restore pinned ${component.role}`,
        });
        dispositions.push(Object.freeze({ ...selected, disposition: exact ? "confirmed_existing_pinned_runtime" : artifactRoute ? "deployed_pinned_runtime_artifact" : "deployed_pinned_historical_version", deployed: !exact }));
      };
      await restore(observations);
      await restore(station);
      await command("gh", ["variable", "set", "UK_AQ_R2_HISTORY_INDEX_VERSION", "--repo", payload.repository, "--body", "v2"], {
        cwd: repositoryRoot, env: childEnvironment, label: "Restore persistent observation-history index authority to v2",
      });
      await restore(cache);
      return Object.freeze({ ok: true, target_index_generation: "v2", evidence_payload_sha256: rollbackEvidence.payload_sha256, components: Object.freeze(dispositions) });
    },
    verifyV2RuntimeAuthority: async () => {
      if (!dispositions || dispositions.length !== components.length) throw new Error("Selected runtime restoration evidence is incomplete");
      const repositoryResult = await command("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
        cwd: repositoryRoot, env: childEnvironment, label: "Verify rollback repository identity", emit: false,
      });
      if (String(repositoryResult.stdout || "").trim() !== payload.repository) throw new Error("Post-rollback GitHub repository identity does not match v2 runtime evidence");
      const authorityResult = await command("gh", ["variable", "get", "UK_AQ_R2_HISTORY_INDEX_VERSION", "--repo", payload.repository], {
        cwd: repositoryRoot, env: childEnvironment, label: "Verify persistent v2 authority", emit: false,
      });
      if (String(authorityResult.stdout || "").trim() !== "v2") throw new Error("Post-rollback persistent observation-history authority is not v2");
      const resolver = await command("bash", ["workers/uk_aq_cache_proxy/resolve_station_history_service.sh", station.worker_name, "v2", ""], {
        cwd: repositoryRoot, env: childEnvironment, label: "Verify local v2 binding resolver", emit: false,
      });
      if (String(resolver.stdout || "").trim() !== station.worker_name) throw new Error("Post-rollback local authority resolver does not select stable station history");
      const deploymentChecks = [];
      for (const selected of dispositions) {
        const component = components.find(entry => entry.role === selected.role);
        const deployment = currentFullDeploymentForVersion(await get(component, "deployments"), selected.selected_version_id, selected.role);
        deploymentChecks.push(Object.freeze({ ...selected, version_id: selected.selected_version_id, deployment_id: deployment.id, percentage: 100 }));
      }
      if (durable) for (const selected of dispositions) await verifyArtifactRuntime({component:components.find(c=>c.role===selected.role),versionId:selected.selected_version_id,repositoryRoot,get,request});
      const selectedCacheVersionId = durable ? dispositions.find(c=>c.role === "cache_worker").selected_version_id : cacheVersionId;
      const cacheVersion = await get(cache, `versions/${encodeURIComponent(selectedCacheVersionId)}`);
      if (cacheVersion?.id !== selectedCacheVersionId || serviceBindingTarget(cacheVersion, "STATION_HISTORY", "Post-rollback cache version") !== station.worker_name) throw new Error("Post-rollback cache binding/version does not match selected pinned v2 authority");
      return Object.freeze({ ok: true, complete: true, index_generation: "v2", observations_reader_generation: "v2", station_reader_generation: "v2", cache_station_binding_generation: "v2", deployments: Object.freeze(deploymentChecks) });
    },
  });
}

// Keep the pinned finaliser's private schedule validator as the authority. Its
// first adapter call is after validation; stop there without performing any I/O.
// This avoids duplicating its hash encoding or rebuilding/replacing the plan.
async function validateMigrationPublicationSchedule(plan) {
  const validated = new Error("V3 publication schedule validated");
  try {
    await finalizeObservationHistoryIndexV3Publication({
      plan,
      putIfChanged: async () => { throw validated; },
      getObject: async () => { throw new Error("Unexpected validation GET"); },
      recordDurableEvidence: async () => { throw new Error("Unexpected validation evidence"); },
    });
  } catch (error) {
    if (error === validated) return;
    throw error;
  }
  throw new Error("V3 publication validation did not reach the publication boundary");
}

export async function finalizeMigrationV3Publication({
  plan,
  putIfChanged,
  getObject,
  recordDurableEvidence,
  recordDurableEvidenceBatch,
  publicationConcurrency = 1,
}) {
  const concurrency = parsePublicationConcurrency(publicationConcurrency);
  if (concurrency === 1) {
    return finalizeObservationHistoryIndexV3Publication({
      plan, putIfChanged, getObject, recordDurableEvidence,
    });
  }
  if (typeof recordDurableEvidenceBatch !== "function") {
    throw new Error("Concurrent publication requires a durable batch adapter");
  }
  await validateMigrationPublicationSchedule(plan);
  const changedKeys = new Set(plan.entries.map((entry) => entry.key));
  const externalByKey = new Map(plan.external_references.map((entry) => [entry.key, entry]));
  const completed = new Set();
  const evidence = [];
  let next = 0;
  while (next < plan.entries.length) {
    const batch = [];
    // Take only an eligible prefix of the immutable topological order. Stopping
    // at a barrier preserves global journal position order, even across batches.
    while (next < plan.entries.length && batch.length < concurrency) {
      const entry = plan.entries[next];
      const blocked = [...entry.dependencies, ...entry.publication_prerequisites].find(
        (reference) => changedKeys.has(reference.key)
          ? !completed.has(reference.key)
          : externalByKey.get(reference.key)?.verified !== true ||
            externalByKey.get(reference.key)?.durable !== true,
      );
      if (blocked) {
        if (batch.length) break;
        throw new Error(`V3 dependent publication blocked: ${blocked.key} -> ${entry.key}`);
      }
      batch.push(entry);
      next += 1;
    }
    // No new batch starts until every started sibling settles and all successful
    // results have passed the single serial durability path below.
    const results = await Promise.allSettled(batch.map(async (entry) => {
      const putResult = await putIfChanged({
        key: entry.key,
        body: Buffer.from(entry.body),
        byte_size: entry.byte_size,
        sha256: entry.sha256,
        content_type: entry.content_type,
        publication_stage: entry.publication_stage,
      });
      if (!putResult || putResult.ok === false) {
        throw new Error(`V3 publication PUT failed: ${entry.key}`);
      }
      const fetched = await getObject({ key: entry.key });
      const fetchedBody = Buffer.isBuffer(fetched?.body)
        ? Buffer.from(fetched.body)
        : Buffer.from(fetched?.body ?? "");
      if (fetchedBody.byteLength !== entry.byte_size || sha256Hex(fetchedBody) !== entry.sha256) {
        throw new Error(`V3 post-PUT GET verification failed: ${entry.key}`);
      }
      return {
        key: entry.key,
        byte_size: entry.byte_size,
        sha256: entry.sha256,
        publication_stage: entry.publication_stage,
        put_status: String(putResult.status || "succeeded"),
        post_put_get_verified: true,
        schedule_sha256: plan.schedule_sha256,
        position: entry.position,
      };
    }));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [new Error(`V3 publication failed: ${batch[index].key}: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`, { cause: result.reason })]
      : []);
    const successes = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    if (successes.length) {
      try {
        // Promise.allSettled preserves input order, hence immutable plan position.
        const durableResult = await recordDurableEvidenceBatch(successes);
        if (durableResult?.durable !== true) {
          throw new Error("Durability adapter did not confirm batch persistence");
        }
      } catch (error) {
        // A failed append may leave an entry beyond its head. No further append
        // or parent publication may use that uncertain sequence/head state.
        throw new AggregateError([...failures, error],
          `V3 durable publication batch failed: ${successes.map((entry) => entry.key).join(", ")}: ${error.message}`);
      }
      for (const entry of successes) {
        completed.add(entry.key);
        evidence.push(Object.freeze({
          key: entry.key,
          byte_size: entry.byte_size,
          sha256: entry.sha256,
          publication_stage: entry.publication_stage,
          put_status: entry.put_status,
          verified: true,
          durable: true,
        }));
      }
    }
    if (failures.length) {
      throw failures[0];
    }
  }
  return Object.freeze({
    ok: true,
    status: "succeeded",
    schedule_sha256: plan.schedule_sha256,
    published_object_count: evidence.length,
    objects: Object.freeze(evidence),
  });
}

function buildR2Adapters({
  config,
  checkpointOut,
  env,
  getBackupObject,
  recoveryProgress = null,
  runtimeAuthorityAdapters = null,
  publicationConcurrency = 1,
}) {
  const r2 = config.r2;
  const durableEvidence = recoveryProgress
    ? [...recoveryProgress.publicationEvidence]
    : [];
  const evidencePath = checkpointOut && !recoveryProgress
    ? `${path.resolve(checkpointOut)}.publication.json`
    : null;
  const stagingRoot = checkpointOut
    ? `${path.resolve(checkpointOut)}.staging`
    : null;
  const requireStagingPath = (candidate) => {
    if (!stagingRoot) throw new Error("Migration staging requires --checkpoint-out");
    const resolved = path.resolve(candidate);
    if (resolved !== stagingRoot && !resolved.startsWith(`${stagingRoot}${path.sep}`)) {
      throw new Error("Migration staging reference escapes the checkpoint staging root");
    }
    return resolved;
  };
  const recordDurableEvidenceBatch = async (entries) => {
    if (recoveryProgress) {
      const result = await recoveryProgress.recordPublicationEvidenceBatch(entries);
      if (result?.durable === true) durableEvidence.push(...entries.map((entry) => ({ ...entry })));
      return result;
    }
    if (!evidencePath) throw new Error("Durable v3 publication evidence requires --checkpoint-out");
    const nextEvidence = [...durableEvidence, ...entries.map((entry) => ({ ...entry }))];
    atomicWriteJson(evidencePath, {
      kind: "uk_aq_observation_history_v3_publication_evidence", objects: nextEvidence,
    });
    durableEvidence.push(...entries.map((entry) => ({ ...entry })));
    return { durable: true };
  };
  return {
    getObject: ({ key }) => r2GetObject({ r2, key }),
    headObject: ({ key }) => r2HeadObject({ r2, key }),
    putChecksumObject: (intent) => putAndVerifyR2ObjectWithSha256({ r2, intent }),
    putJsonObject: (object) => r2PutObject({
      r2,
      key: object.key,
      body: object.body,
      content_type: object.content_type,
    }),
    putIfChanged: (object) => r2PutObjectIfChanged({
      r2,
      key: object.key,
      body: object.body,
      content_type: object.content_type,
      writeR2: true,
    }),
    recordDurableEvidence: (entry) => recordDurableEvidenceBatch([entry]),
    recordDurableEvidenceBatch,
    getDurablePublicationEvidence: () => durableEvidence.map((entry) => ({ ...entry })),
    writeCheckpoint: recoveryProgress
      ? recoveryProgress.persistCheckpoint
      : async (checkpoint) => atomicWriteJson(checkpointOut, checkpoint),
    stageUnit: async ({ unitId, intents }) => {
      if (!stagingRoot) throw new Error("Migration staging requires --checkpoint-out");
      const unitDirectory = requireStagingPath(path.join(stagingRoot, unitId));
      fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
      return intents.map((intent, index) => {
        const target = requireStagingPath(
          path.join(unitDirectory, `${String(index).padStart(5, "0")}.parquet`),
        );
        const body = Buffer.from(intent.body);
        if (
          body.byteLength !== intent.byte_size ||
          sha256Hex(body) !== intent.sha256
        ) {
          throw new Error(`Prepared migration body identity is invalid: ${intent.key}`);
        }
        const temporary = `${target}.tmp-${process.pid}`;
        try {
          fs.writeFileSync(temporary, body, { mode: 0o600 });
          fs.renameSync(temporary, target);
        } finally {
          if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
        return {
          key: intent.key,
          byte_size: intent.byte_size,
          sha256: intent.sha256,
          staging_ref: target,
        };
      });
    },
    readStagedBody: async ({ staging_ref: stagingRef, key }) => {
      if (!stagingRef) throw new Error(`Prepared migration body is unavailable: ${key}`);
      const target = requireStagingPath(stagingRef);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`Prepared migration body is unavailable: ${key}`);
      }
      return fs.readFileSync(target);
    },
    releaseStagedUnit: async ({ intents }) => {
      const directories = new Set();
      for (const intent of intents) {
        if (!intent.staging_ref) continue;
        const target = requireStagingPath(intent.staging_ref);
        directories.add(path.dirname(target));
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      for (const directory of directories) {
        if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
          fs.rmdirSync(directory);
        }
      }
      if (stagingRoot && fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) {
        fs.rmdirSync(stagingRoot);
      }
    },
    getBackupObject,
    finalizeV3Publication: (options) =>
      finalizeMigrationV3Publication({ ...options, publicationConcurrency }),
    rebuildV2Indexes: () => runHistoryIndexBuild({
      argv: ["--history-version", "v2", "--domain", "observations", "--write-r2"],
      env,
    }),
    verifyV2IndexCompleteness: ({ restorePlan }) => {
      const expectedCanonicalRootIdentity = restorePlan.objects.find(
        (entry) => entry.stage === "root_manifest",
      );
      if (!expectedCanonicalRootIdentity) {
        throw new Error("Rollback restore plan lacks canonical root identity");
      }
      return verifyObservationHistoryV2IndexCompleteness({
        getR2Object: ({ key }) => r2GetObject({ r2: config.r2, key }),
        bucket: config.r2.bucket,
        observationsPrefix: config.observations_prefix_v2,
        v2IndexRoot: config.observations_timeseries_index_prefix_v2,
        v2LatestKey: buildR2HistoryV2ObservationsTimeseriesLatestKey(
          config.index_prefix_v2,
        ),
        expectedCanonicalRootIdentity,
      });
    },
    ...(runtimeAuthorityAdapters || {}),
  };
}

export async function runObservationHistoryMigrationV3({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date().toISOString(),
  runLockedCommand = runCommandWithObservationsGlobalOperationLock,
} = {}) {
  const args = parseObservationHistoryMigrationArgs(argv);
  if (args.help) return { help: true, text: usage() };
  if (args.mode === "migrate" && !args.checkpointIn && (!args.operatorAuthorityFile || !args.v2RuntimeRollbackRecord)) throw new Error("Fresh migration requires --operator-authority-file and --v2-runtime-rollback-record");
  if (args.mode === "migrate" && args.checkpointIn && !args.operatorAuthorityFile) throw new Error("Resume requires --operator-authority-file to distinguish immutable runtime pin from historical compatibility");
  if (args.mode !== "runtime-recoverability" && args.v2RuntimeRollbackRecord && !args.operatorAuthorityFile && readJsonFile(args.v2RuntimeRollbackRecord, "runtime evidence").schema_version === 2) throw new Error("Durable runtime evidence requires --operator-authority-file");
  if (args.mode === "runtime-recoverability") {
    // Diagnostic only. This does not replace formal rollback preflight or grant
    // mutation authority; no lock, R2/Dropbox transport or deployment is entered.
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    if (!args.reportOut) throw new Error("runtime-recoverability requires --report-out");
    const rollbackEvidence = readJsonFile(args.v2RuntimeRollbackRecord, "v2 runtime rollback record");
    const validated = validateIndexV3OperatorEvidence({ evidence: rollbackEvidence, repositoryRoot });
    if (validated.kind !== "uk_aq_index_v3_v2_runtime_rollback_record" ||
        validated.environment.toUpperCase() !== String(args.environment || "").toUpperCase() ||
        validated.environment.toUpperCase() !== String(env.UKAQ_ENV_NAME || "").toUpperCase()) {
      throw new Error("Runtime recovery diagnostic environment or evidence kind mismatch");
    }
    const identity = await runOperatorCommand("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repositoryRoot, env, label: "Runtime recovery: verifying repository", emit: false,
    });
    if (identity.stdout.trim() !== validated.repository) throw new Error("Runtime recovery diagnostic repository mismatch");
    let result;
    try {
      result = await v2RuntimeAuthorityAdapters({ rollbackEvidence, repositoryRoot, env }).checkV2RuntimeRecoverability();
    } catch (error) {
      if (!error.runtimeRecoverability) throw error;
      result = { ...error.runtimeRecoverability, status: "unrecoverable", error: error.message };
    }
    const output = { result: { ...result, status: result.ok ? "runtime_recoverable" : "unrecoverable", diagnostic_only: true, mutation_calls: 0 } };
    atomicWriteJson(args.reportOut, output);
    return output;
  }
  if (args.operatorAuthorityFile) {
    const authority = readJsonFile(args.operatorAuthorityFile, "operator authority");
    const bytes = args.v2RuntimeRollbackRecord ? fs.readFileSync(args.v2RuntimeRollbackRecord) : null;
    const compatibility = assertRuntimeRecordPin(authority, bytes, {allowLegacy: args.mode !== "migrate" || Boolean(args.checkpointIn)});
    const identities = {environment:args.environment, transition:args.transition, migration_run_id:args.migrationRunId, target_writer_git_sha:args.targetWriterGitSha, plan_sha256:args.expectedPlanSha256, inventory_root_sha256:args.expectedInventoryRootSha256, state_root_sha256:args.expectedStateRootSha256};
    for (const [key,value] of Object.entries(identities)) if (authority[key] !== value) throw new Error(`Runtime operator authority ${key} differs from historical migration identity`);
    if (!compatibility.legacy) {
      const record = JSON.parse(bytes);
      validateIndexV3OperatorEvidence({evidence:record,repositoryRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")});
      if (args.mode === "migrate" && args.transition === "v2-to-v3") await verifyCurrentRuntimeEvidence(record, args.environment, env, authority);
    }
  }
  if (args.mode === "migrate" && args.checkpointIn) {
    process.on("SIGHUP", () => {
      process.stderr.write(
        "Recovery migration ignored SIGHUP; SIGINT/SIGTERM remain available for controlled stop.\n",
      );
    });
  }
  requireCommonArgs(args);
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Complete configured R2 endpoint, bucket, region and credentials are required");
  }
  const evidence = environmentEvidence(args, env, config);
  const writerLimits = assertAcceptedObservationHistoryWriterLimitsV3(
    readJsonFile(args.writerLimitsPath, "writer limits"),
    "migration --writer-limits-json",
  );
  if (new Set(["migrate", "rollback"]).has(args.mode)) {
    const lockOwner = args.mode === "rollback"
      ? `observation_history_rollback_${args.transition.replaceAll("-", "_")}`
      : `observation_history_migration_${args.transition.replaceAll("-", "_")}`;
    const lockContext = observationsGlobalOperationLockContext({
      env,
      expectedOwner: lockOwner,
      expectedRunId: args.migrationRunId,
    });
    if (lockContext.held && !lockContext.valid) {
      throw new Error(
        `${args.mode} --apply received an invalid observations global operation lock context`,
      );
    }
    if (!lockContext.valid) {
      const diagnostics = [];
      let exitCode;
      try {
        exitCode = await runLockedCommand({
          databaseUrl: env.SUPABASE_DB_URL || env.DATABASE_URL,
          owner: lockOwner,
          runId: args.migrationRunId,
          command: process.execPath,
          commandArgs: [
            ...(args.checkpointIn ? process.execArgv : []),
            fileURLToPath(import.meta.url),
            ...argv,
          ],
          env,
          diagnostics,
        });
      } finally {
        for (const diagnostic of diagnostics) {
          process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
        }
      }
      return { delegated: true, exitCode };
    }
  }
  const getBackupObject = buildDropboxBackupReader(args.dropboxRoot);
  const getR2Object = ({ key }) => r2GetObject({ r2: config.r2, key });
  const startedAt = now();
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDirectory, "../..");
  let v2RuntimeRollbackEvidence = null;
  if (args.mode === "rollback") {
    v2RuntimeRollbackEvidence = readJsonFile(
      args.v2RuntimeRollbackRecord,
      "v2 runtime rollback record",
    );
    const validation = validateIndexV3OperatorEvidence({
      evidence: v2RuntimeRollbackEvidence,
      repositoryRoot,
    });
    if (
      validation.environment.toUpperCase() !== args.environment.toUpperCase() ||
      validation.kind !== "uk_aq_index_v3_v2_runtime_rollback_record"
    ) {
      throw new Error("v2 runtime rollback record does not match the requested environment");
    }
    const currentBranch = spawnSync("git", ["branch", "--show-current"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const currentRepository = spawnSync("gh", [
      "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner",
    ], { cwd: repositoryRoot, encoding: "utf8" });
    if (
      currentBranch.status !== 0 ||
      String(currentBranch.stdout || "").trim() !== v2RuntimeRollbackEvidence.payload.branch ||
      currentRepository.status !== 0 ||
      String(currentRepository.stdout || "").trim() !== v2RuntimeRollbackEvidence.payload.repository
    ) {
      throw new Error("v2 runtime rollback record does not match the current repository/branch");
    }
  }
  let checkpoint = args.checkpointIn
    ? readJsonFile(args.checkpointIn, "migration checkpoint")
    : null;
  let recoveryProgress = null;
  if (checkpoint && args.mode === "migrate") {
    recoveryProgress = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath: args.checkpointIn,
      checkpoint,
      repositoryRoot,
      // The original manifest remains historical authority. Enforce the narrow
      // committed-executor drift gate separately, before any migration R2 work.
      requireCurrentImplementation: false,
      diagnostics: true,
    });
    const recoveryExecutorCheck = spawnSync("bash", [
      "scripts/index_v3_migration/index_v3_migration.sh",
      "--resume-implementation-authority",
      path.resolve(args.checkpointIn),
      args.targetWriterGitSha,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    if (recoveryExecutorCheck.status !== 0) {
      throw new Error(`Resume recovery executor is not authorized: ${
        recoveryExecutorCheck.stderr || recoveryExecutorCheck.error?.message || "local authority check failed"
      }`);
    }
    checkpoint = recoveryProgress.checkpoint;
  } else if (checkpoint && new Set(["rollback-plan", "rollback"]).has(args.mode)) {
    // Rollback never falls back to an unauthenticated checkpoint or requires
    // the current recovery executor to impersonate the historical writer.
    // Load this rollback-only helper lazily so resume/verify retain their
    // existing dependency trust models.
    const { authenticateRollbackExecutor } = await import(
      "../index_v3_migration/rollback_executor_authority.mjs"
    );
    recoveryProgress = await authenticateRollbackExecutor({
      repositoryRoot,
      checkpointPath: args.checkpointIn,
      migrationRunId: args.migrationRunId,
      planSha256: args.expectedPlanSha256,
      targetWriterGitSha: args.targetWriterGitSha,
      transition: args.transition,
      inventoryRootSha256: args.expectedInventoryRootSha256,
      stateRootSha256: args.expectedStateRootSha256,
    });
    checkpoint = recoveryProgress.checkpoint;
  } else if (
    checkpoint &&
    fs.existsSync(recoveryProgressPaths(args.checkpointIn).manifest)
  ) {
    recoveryProgress = buildObservationHistoryV3RecoveryProgressContext({
      checkpointPath: args.checkpointIn,
      checkpoint,
      repositoryRoot,
      requireCurrentImplementation: args.mode !== "verify",
    });
    checkpoint = recoveryProgress.checkpoint;
  }
  const plan = checkpoint
    ? await withOperatorPhase("Migration: reconstructing checkpoint plan", () => buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint }))
    : await withOperatorPhase("Migration: constructing plan", () => buildObservationHistoryV3MigrationPlan({
        getR2Object,
        getBackupObject,
        repositoryRoot,
        environmentEvidence: evidence,
        migrationRunId: args.migrationRunId,
        writerLimits,
        targetWriterGitSha: args.targetWriterGitSha,
        expectedInventoryRootSha256: args.expectedInventoryRootSha256,
        expectedStateRootSha256: args.expectedStateRootSha256,
      }));
  if (
    args.expectedPlanSha256 &&
    plan.plan_sha256 !== String(args.expectedPlanSha256).trim().toLowerCase()
  ) {
    throw new Error("Migration plan identity does not match --expected-plan-sha256");
  }
  if (
    checkpoint &&
    (
      plan.migration_run_id !== args.migrationRunId ||
      plan.transition.kind !== args.transition ||
      plan.target_writer_git_sha !== args.targetWriterGitSha ||
      stableMigrationJson(plan.target.writer_limits) !== stableMigrationJson(writerLimits) ||
      plan.backup_gate?.inventory_root?.sha256 !==
        String(args.expectedInventoryRootSha256).toLowerCase() ||
      plan.backup_gate?.state_root?.sha256 !==
        String(args.expectedStateRootSha256).toLowerCase()
    )
  ) {
    throw new Error(
      "Checkpoint identity does not match the requested run, writer, limits or backup generation",
    );
  }
  const adapters = buildR2Adapters({
    config,
    checkpointOut: args.checkpointOut || args.checkpointIn,
    env,
    getBackupObject,
    recoveryProgress,
    publicationConcurrency: args.publicationConcurrency,
    runtimeAuthorityAdapters: v2RuntimeRollbackEvidence
      ? v2RuntimeAuthorityAdapters({
          rollbackEvidence: v2RuntimeRollbackEvidence,
          repositoryRoot,
          env,
        })
      : null,
  });
  let result;
  let rollback = null;
  let reportPlan = plan;
  try {
    if (args.mode === "plan") {
      result = summaryForPlan(plan);
    } else if (args.mode === "migrate") {
      process.stderr.write(`V3 migration: concurrency=${args.publicationConcurrency} for resumed Parquet/canonical verification and v3 publication\n`);
      result = await withOperatorPhase("Migration: publishing and verifying v3", () => executeObservationHistoryV3MigrationPlan({
        plan,
        apply: true,
        writersFrozen: args.writersFrozen,
        environmentEvidence: evidence,
        checkpoint,
        recoveryAuthority: recoveryProgress?.authenticatedRecoveryAuthority || null,
        publicationConcurrency: args.publicationConcurrency,
        onReconstructedPlan: (completedPlan) => { reportPlan = completedPlan; },
        adapters,
      }));
    } else if (args.mode === "verify") {
      const currentEnvironment = validateObservationHistoryV3MigrationEnvironment({
        ...evidence,
        operation: "verification",
      });
      if (
        currentEnvironment.ok !== true ||
        currentEnvironment.environment !== plan.environment.environment ||
        currentEnvironment.bucket !== plan.environment.bucket ||
        currentEnvironment.history_version !== plan.environment.history_version ||
        currentEnvironment.integrity_version !== plan.environment.integrity_version
      ) {
        throw new Error(
          `Current verification environment differs from pinned migration authority: ${currentEnvironment.blockers.join(",")}`,
        );
      }
      reportPlan = buildObservationHistoryV3RerunVerificationPlan({
        checkpoint,
        allowLegacyRecoveryOrdering: args.environment === "TEST",
        recoveryAuthority: recoveryProgress?.authenticatedRecoveryAuthority || null,
        progressEnabled: true,
      });
      result = await withOperatorPhase("Migration: final independent verification", () => verifyObservationHistoryV3CurrentDependencies({
        plan: reportPlan,
        checkpoint,
        getObject: adapters.getObject,
        headObject: adapters.headObject,
        publicationResult: { ok: true, checkpoint_evidence: true },
      }));
    } else {
      const restorePlan = await withOperatorPhase("Rollback: reconstructing restore plan", () => buildObservationHistoryV2RestorePlan({
        checkpoint,
        getBackupObject,
      }));
      if (args.mode === "rollback-plan") {
        result = {
          kind: restorePlan.kind,
          migration_run_id: restorePlan.migration_run_id,
          object_count: restorePlan.objects.length,
          objects: restorePlan.objects.map(({ body: _body, ...object }) => object),
          backup_checkpoint: {
            inventory_root: {
              key: restorePlan.backup_checkpoint.inventory_root.key,
              byte_size: restorePlan.backup_checkpoint.inventory_root.byte_size,
              sha256: restorePlan.backup_checkpoint.inventory_root.sha256,
            },
            state_root: {
              key: restorePlan.backup_checkpoint.state_root.key,
              byte_size: restorePlan.backup_checkpoint.state_root.byte_size,
              sha256: restorePlan.backup_checkpoint.state_root.sha256,
            },
          },
          v2_index_strategy: restorePlan.v2_index_strategy,
          v3_index_strategy: restorePlan.v3_index_strategy,
          ready: restorePlan.ready,
          dry_run: true,
          mutation_calls: 0,
        };
      } else {
        rollback = await executeObservationHistoryV2Rollback({
          restorePlan,
          apply: true,
          writersFrozen: args.writersFrozen,
          environmentEvidence: evidence,
          adapters,
        });
        result = rollback;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureCategory = args.mode === "verify"
      ? migrationVerificationFailureCategory(message)
      : null;
    const failure = {
      ok: false,
      status: "failed",
      error: message,
      runtime_recoverability: error.runtimeRecoverability || null,
      runtime_recovery: adapters.getV2RuntimeRecoveryEvidence?.() || null,
      failure_category: failureCategory,
      verification: {
        blockers: [`operation_failed:${message}`],
        failure_category: failureCategory,
      },
    };
    const failedAudit = buildObservationHistoryV3MigrationAuditReport({
      plan: reportPlan,
      mode: args.mode,
      startedAt,
      completedAt: now(),
      execution: failure,
      rollback: args.mode === "rollback"
        ? { required: true, status: "failed" }
        : null,
    });
    atomicWriteJson(args.reportOut, buildObservationHistoryV3ReportOutput({
      result: failure,
      audit: failedAudit,
      mode: args.mode,
      checkpoint,
    }));
    throw error;
  }
  const completedAt = now();
  const audit = buildObservationHistoryV3MigrationAuditReport({
    plan: reportPlan,
    mode: args.mode,
    startedAt,
    completedAt,
    execution: args.mode === "migrate"
      ? result
      : args.mode === "verify"
        ? { verification: result, v3_publication: { ok: true } }
        : null,
    rollback,
  });
  const output = buildObservationHistoryV3ReportOutput({
    result,
    audit,
    mode: args.mode,
    checkpoint,
  });
  atomicWriteJson(args.reportOut, output);
  return output;
}

export async function main(options = {}) {
  const output = await runObservationHistoryMigrationV3(options);
  if (output.delegated) return output.exitCode;
  if (output.help) {
    process.stdout.write(`${output.text}\n`);
    return 0;
  }
  process.stdout.write(`${stableMigrationJson(output)}`);
  return output.result?.ok === false || output.audit?.blockers?.length ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const execution = process.env.UK_AQ_OPERATOR_SUPERVISED === "1" || process.argv.includes("--help")
    ? main() : superviseOperatorInvocation(process.argv[1], process.argv.slice(2));
  execution.then((code) => {
    finishOperatorProgress(code ? "failed" : "complete");
    process.exitCode = code;
  }).catch((error) => {
    finishOperatorProgress("failed");
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
