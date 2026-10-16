import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readAndValidateRecoveryJournal } from "./recovery_journal_authority.mjs";
import { readShardedMigrationPlan, sha256StableMigrationJson } from "../backup_r2/lib/observation_history_migration_plan_store.mjs";

export const EXCEPTIONAL_LIVE_RECOVERY = Object.freeze({
  run_id: "live-v3-20261015T114250Z-e84f52a",
  original_commit: "e84f52a6b0ddb6212fc6f321b875bb15244c4090",
  plan_sha256: "1e960674e53cd2ddb3c5d08a3318fcce1abc72ebe7a2dc92e11e9ce9a4d79600",
  authority_sha256: "80ac1e8b1c975d66036a170cd78bce2680c256b36131f3505530789b6c3599b6",
  journal_sequence: 46305,
  journal_head_sha256: "6f1c5807f419ce9a9c87178ce21853655f9892545f94959528f60816be34441d",
  source_root_key: "history/v2/observations/_manifests/manifest.json",
  source_root_sha256: "002266b482d966fe188b594313b12c93072b30aa6b8c6c0c79c8249785abd2fd",
  expected_v3_publications: 1328147,
});

const CODE_PATHS = Object.freeze([
  "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  "scripts/backup_r2/uk_aq_observation_history_migration_v3_live_gcp.mjs",
  "scripts/backup_r2/lib/observation_history_migration_v3.mjs",
  "scripts/backup_r2/lib/observation_history_migration_gcp.mjs",
  "scripts/backup_r2/lib/observation_history_migration_plan_store.mjs",
  "scripts/backup_r2/lib/observation_history_migration_concurrency.mjs",
  "scripts/backup_r2/lib/observation_history_migration_worker_pool.mjs",
  "scripts/backup_r2/lib/observation_history_migration_worker.mjs",
  "scripts/backup_r2/lib/observation_history_migration_bounded_r2.mjs",
  "scripts/index_v3_migration/recovery_journal_authority.mjs",
  "scripts/index_v3_migration/exceptional_recovery_authority.mjs",
  "scripts/backup_r2/lib/observation_history_generation_bindings.mjs",
  "workers/shared/uk_aq_observation_history_index_v3.mjs",
  "workers/shared/uk_aq_r2_checksum_publication.mjs",
  "workers/shared/uk_aq_r2_history_index.mjs",
  "workers/shared/r2_sigv4.mjs",
]);

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function getExceptionalRecoveryCodeIdentity(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const files = CODE_PATHS.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return { path: relativePath, byte_size: bytes.byteLength, sha256: sha256(bytes) };
  });
  return Object.freeze({ repository_head: head, files: Object.freeze(files) });
}

export function exceptionalRecoveryCodeSha256(identity) {
  return sha256(Buffer.from(JSON.stringify(identity)));
}

export function verifyOriginalRecoveryImplementation({ manifest, repositoryRoot }) {
  const implementation = manifest?.payload?.recovery_implementation;
  if (!implementation || implementation.repository_head !== EXCEPTIONAL_LIVE_RECOVERY.original_commit ||
      !Array.isArray(implementation.files) || !implementation.files.length) {
    throw new Error("Original recovery implementation identity differs from the authorised LIVE run");
  }
  const root = path.resolve(repositoryRoot);
  for (const file of implementation.files) {
    if (!file || path.isAbsolute(file.path) || file.path.split("/").includes("..")) {
      throw new Error("Original recovery implementation manifest contains an unsafe path");
    }
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `${implementation.repository_head}:${file.path}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`Original recovery Git object is unavailable for ${file.path}`, { cause: error });
    }
    if (bytes.byteLength !== file.byte_size || sha256(bytes) !== file.sha256) {
      throw new Error(`Original recovery implementation file identity differs: ${file.path}`);
    }
  }
  return implementation;
}

export function authenticateExceptionalRecovery({ checkpointPath, repositoryRoot }) {
  const absoluteCheckpoint = path.resolve(checkpointPath);
  const checkpointBytes = fs.readFileSync(absoluteCheckpoint);
  const checkpointSha256 = sha256(checkpointBytes);
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  if (checkpoint.progress_format !== "authenticated-journal-v1" ||
      checkpoint.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id ||
      checkpoint.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
      checkpoint.authority_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256) {
    throw new Error("Exceptional recovery immutable checkpoint identity differs from the authorised run");
  }
  if (checkpoint.authority_format === "uk_aq_migration_plan_shards_v1") {
    const { plan } = readShardedMigrationPlan(checkpoint.authority_ref);
    if (checkpoint.authority_ref.full_plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256 ||
        plan.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
        plan.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id) {
      throw new Error("Exceptional recovery immutable sharded plan identity differs from the authorised run");
    }
    checkpoint.authority = plan;
  } else if (!checkpoint.authority || sha256StableMigrationJson(checkpoint.authority) !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256) {
    throw new Error("Exceptional recovery inline plan identity differs from the authorised run");
  }
  const journal = readAndValidateRecoveryJournal({
    recoveryRoot: `${absoluteCheckpoint}.recovery`,
    expectedCheckpointSha256: checkpointSha256,
    expectedCheckpointByteSize: checkpointBytes.byteLength,
    expectedAuthoritySha256: EXCEPTIONAL_LIVE_RECOVERY.authority_sha256,
    expectedMigrationRunId: EXCEPTIONAL_LIVE_RECOVERY.run_id,
    expectedPlanSha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
  });
  const originalImplementation = verifyOriginalRecoveryImplementation({
    manifest: journal.manifest,
    repositoryRoot,
  });
  if (journal.manifest.payload.original_checkpoint.path !== absoluteCheckpoint) {
    throw new Error("Exceptional recovery checkpoint path differs from the authenticated original path");
  }
  if (journal.last_sequence !== EXCEPTIONAL_LIVE_RECOVERY.journal_sequence ||
      journal.last_entry_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256) {
    throw new Error("Exceptional recovery journal head differs from the independently recorded failed-run evidence");
  }
  const currentImplementation = getExceptionalRecoveryCodeIdentity(repositoryRoot);
  return Object.freeze({ checkpoint, journal, originalImplementation, currentImplementation });
}

export function exceptionalRecoveryApprovalPhrase({ auth, sourceRoot, codeSha, codeHead, runner }) {
  if (sourceRoot?.key !== EXCEPTIONAL_LIVE_RECOVERY.source_root_key ||
      sourceRoot?.byte_size !== 559 || sourceRoot?.sha256 !== EXCEPTIONAL_LIVE_RECOVERY.source_root_sha256) {
    throw new Error("Current source-root identity differs from the authorised LIVE migration");
  }
  if (runner?.runner_kind !== "gcp" || runner?.runner_profile !== "gcp-c4a-32" ||
      !runner.project_id || !runner.zone || runner.machine_type !== "c4a-standard-32") {
    throw new Error("Exceptional recovery approval requires the admitted LIVE GCP execution identity");
  }
  const p = auth.journal;
  return `APPROVE EXCEPTIONAL UK-AQ LIVE V3 RESUME ${EXCEPTIONAL_LIVE_RECOVERY.run_id} ` +
    `CHECKPOINT ${auth.journal.manifest.payload.original_checkpoint.sha256} AUTHORITY ${EXCEPTIONAL_LIVE_RECOVERY.authority_sha256} ` +
    `PLAN ${EXCEPTIONAL_LIVE_RECOVERY.plan_sha256} JOURNAL ${p.last_sequence} ${p.last_entry_sha256} ` +
    `ORIGINAL_CODE ${auth.originalImplementation.repository_head} NEW_CODE ${codeHead} ${codeSha} ` +
    `SOURCE ${sourceRoot.sha256} BUCKET uk-aq-history-live ACCOUNT 7e20426335c509cc77483210fa7ead0f ` +
    `GCP ${runner.project_id} ${runner.zone} c4a-standard-32 APPLY WRITERS_FROZEN\n`;
}

export function validateExceptionalRecoveryApproval({ filePath, expectedPhrase, validFromMs, now = Date.now() }) {
  const approvalPath = path.resolve(filePath);
  const stat = fs.lstatSync(approvalPath);
  const bytes = fs.readFileSync(approvalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 || stat.size > 1024 || stat.mtimeMs < validFromMs ||
      now - stat.mtimeMs > 30 * 60 * 1000 || bytes.toString("utf8") !== expectedPhrase) {
    throw new Error("Exceptional recovery approval is stale, unsafe or does not match the exact authenticated run/code identities");
  }
  return Object.freeze({ kind: "uk_aq_observation_history_v3_exceptional_resume_approval_v1",
    approved_at_utc: new Date(stat.mtimeMs).toISOString(), approval_file_sha256: sha256(bytes),
    approval_file_byte_size: bytes.byteLength });
}
