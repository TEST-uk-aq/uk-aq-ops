#!/usr/bin/env node

import fs from "node:fs";
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
  hasRequiredR2Config,
  r2GetObject,
  r2HeadObject,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  r2PutObjectIfChanged,
  resolveR2HistoryIndexConfig,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { runHistoryIndexBuild } from "./uk_aq_build_r2_history_index.mjs";
import {
  buildObservationHistoryV2RestorePlan,
  buildObservationHistoryV3MigrationAuditReport,
  buildObservationHistoryV3MigrationPlan,
  buildObservationHistoryV3MigrationPlanFromCheckpoint,
  buildObservationHistoryV3RerunVerificationPlan,
  executeObservationHistoryV2Rollback,
  executeObservationHistoryV3MigrationPlan,
  stableMigrationJson,
  verifyObservationHistoryV3MigrationResult,
} from "./lib/observation_history_migration_v3.mjs";

const MODES = new Set([
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
    "  --mode rollback-plan    Build the manifest-guided v2 restore plan",
    "  --mode rollback         Restore canonical v2 bytes and rebuild observation _index_v2",
    "",
    "Required for every mode:",
    "  --environment CIC-Test",
    "  --expected-bucket <exact TEST bucket>",
    "  --migration-run-id <stable operator identity>",
    "  --target-writer-git-sha <exact deployed migration code identity>",
    "  --writer-limits-json <Phase 1 writer limits JSON>",
    "  --dropbox-root <local directory or rclone remote:path>",
    "  --expected-inventory-root-sha256 <hex>",
    "  --expected-state-root-sha256 <hex>",
    "  --report-out <audit JSON path>",
    "",
    "Mutation-only requirements:",
    "  --apply                  Explicitly permit R2 mutation",
    "  --writers-frozen         Confirm every planner-listed writer is paused",
    "  --checkpoint-out <path>  Required for migrate; atomically updated after each object",
    "",
    "Resume/verify:",
    "  --checkpoint-in <path>   Prior checkpoint; required for verify/rollback and migrate resume",
    "",
    "The command never changes configuration, scheduler state, deployments, or reader generation.",
  ].join("\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseObservationHistoryMigrationArgs(argv) {
  const args = {
    mode: "plan",
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
    reportOut: null,
    checkpointIn: null,
    checkpointOut: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--writers-frozen") args.writersFrozen = true;
    else if (flag === "--mode") args.mode = requireValue(argv, index++, flag);
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
    else if (flag === "--checkpoint-in") args.checkpointIn = requireValue(argv, index++, flag);
    else if (flag === "--checkpoint-out") args.checkpointOut = requireValue(argv, index++, flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!MODES.has(args.mode)) throw new Error(`Unsupported --mode: ${args.mode}`);
  if (args.apply && !new Set(["migrate", "rollback"]).has(args.mode)) {
    throw new Error("--apply is valid only with --mode migrate or --mode rollback");
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
    writer_freeze_plan: plan.writer_freeze_plan,
    partitions: plan.units.map((unit) => ({
      unit_id: unit.unit_id,
      scope: unit.scope,
      source_manifest_identity: unit.source_manifest_identity,
      source_files: unit.source_files,
      source_row_count: unit.source_row_count,
      source_observation_content_hash: unit.source_observation_content_hash,
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

function buildR2Adapters({ config, checkpointOut, env, getBackupObject }) {
  const r2 = config.r2;
  const durableEvidence = [];
  const evidencePath = checkpointOut
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
    recordDurableEvidence: async (entry) => {
      if (!evidencePath) {
        throw new Error("Durable v3 publication evidence requires --checkpoint-out");
      }
      durableEvidence.push({ ...entry });
      atomicWriteJson(evidencePath, {
        kind: "uk_aq_observation_history_v3_publication_evidence",
        objects: durableEvidence,
      });
      return { durable: true };
    },
    writeCheckpoint: async (checkpoint) => atomicWriteJson(checkpointOut, checkpoint),
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
      finalizeObservationHistoryIndexV3Publication(options),
    rebuildV2Indexes: () => runHistoryIndexBuild({
      argv: ["--history-version", "v2", "--domain", "observations", "--write-r2"],
      env,
    }),
  };
}

export async function runObservationHistoryMigrationV3({
  argv = process.argv.slice(2),
  env = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  const args = parseObservationHistoryMigrationArgs(argv);
  if (args.help) return { help: true, text: usage() };
  requireCommonArgs(args);
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Complete configured R2 endpoint, bucket, region and credentials are required");
  }
  const evidence = environmentEvidence(args, env, config);
  const writerLimits = readJsonFile(args.writerLimitsPath, "writer limits");
  const getBackupObject = buildDropboxBackupReader(args.dropboxRoot);
  const getR2Object = ({ key }) => r2GetObject({ r2: config.r2, key });
  const startedAt = now();
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const checkpoint = args.checkpointIn
    ? readJsonFile(args.checkpointIn, "migration checkpoint")
    : null;
  const plan = checkpoint
    ? buildObservationHistoryV3MigrationPlanFromCheckpoint({ checkpoint })
    : await buildObservationHistoryV3MigrationPlan({
        getR2Object,
        getBackupObject,
        repositoryRoot: path.resolve(scriptDirectory, "../.."),
        environmentEvidence: evidence,
        migrationRunId: args.migrationRunId,
        writerLimits,
        targetWriterGitSha: args.targetWriterGitSha,
        expectedInventoryRootSha256: args.expectedInventoryRootSha256,
        expectedStateRootSha256: args.expectedStateRootSha256,
      });
  if (
    checkpoint &&
    (
      plan.migration_run_id !== args.migrationRunId ||
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
  });
  let result;
  let rollback = null;
  let reportPlan = plan;
  try {
    if (args.mode === "plan") {
      result = summaryForPlan(plan);
    } else if (args.mode === "migrate") {
      result = await executeObservationHistoryV3MigrationPlan({
        plan,
        apply: true,
        writersFrozen: args.writersFrozen,
        environmentEvidence: evidence,
        checkpoint,
        adapters,
      });
      reportPlan = buildObservationHistoryV3MigrationPlanFromCheckpoint({
        checkpoint: result.checkpoint,
        requirePrepared: true,
      });
    } else if (args.mode === "verify") {
      reportPlan = buildObservationHistoryV3RerunVerificationPlan({
        checkpoint,
      });
      result = await verifyObservationHistoryV3MigrationResult({
        plan: reportPlan,
        getObject: adapters.getObject,
        headObject: adapters.headObject,
        publicationResult: { ok: true, checkpoint_evidence: true },
      });
    } else {
      const restorePlan = await buildObservationHistoryV2RestorePlan({
        checkpoint,
        getBackupObject,
      });
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
    const failure = {
      ok: false,
      status: "failed",
      error: message,
      verification: { blockers: [`operation_failed:${message}`] },
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
    atomicWriteJson(args.reportOut, { result: failure, audit: failedAudit });
    throw error;
  }
  const completedAt = now();
  const audit = buildObservationHistoryV3MigrationAuditReport({
    plan: reportPlan,
    mode: args.mode,
    startedAt,
    completedAt,
    execution: args.mode === "migrate" ? result : null,
    rollback,
  });
  const output = { result, audit };
  atomicWriteJson(args.reportOut, output);
  return output;
}

export async function main(options = {}) {
  const output = await runObservationHistoryMigrationV3(options);
  if (output.help) {
    process.stdout.write(`${output.text}\n`);
    return 0;
  }
  process.stdout.write(`${stableMigrationJson(output)}`);
  return output.result?.ok === false || output.audit?.blockers?.length ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
