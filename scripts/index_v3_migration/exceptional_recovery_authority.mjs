import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectRecoveryJournalForInterruptedAppend } from "./recovery_journal_authority.mjs";
import { readShardedMigrationPlan, sha256StableMigrationJson } from "../backup_r2/lib/observation_history_migration_plan_store.mjs";
import { createEvidenceRelocation } from "./evidence_relocation.mjs";

export const EXCEPTIONAL_LIVE_RECOVERY = Object.freeze({
  run_id: "live-v3-20261015T114250Z-e84f52a",
  original_commit: "e84f52a6b0ddb6212fc6f321b875bb15244c4090",
  plan_sha256: "1e960674e53cd2ddb3c5d08a3318fcce1abc72ebe7a2dc92e11e9ce9a4d79600",
  authority_sha256: "80ac1e8b1c975d66036a170cd78bce2680c256b36131f3505530789b6c3599b6",
  journal_sequence: 46305,
  journal_head_sha256: "6f1c5807f419ce9a9c87178ce21853655f9892545f94959528f60816be34441d",
  authenticated_completed_objects: 340314,
  authenticated_v3_publications: 185519,
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

const EPOCH_KIND = "uk_aq_observation_history_v3_exceptional_recovery_epoch";
const EPOCH_DIR_SUFFIX = ".exceptional-recovery-epochs";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const AUTHORIZATION_BRAND = Symbol("authenticated-exceptional-recovery-authority");

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const stableObject = (value) => {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
};
const stableJson = (value) => `${JSON.stringify(stableObject(value), null, 2)}\n`;
const equalStable = (a, b) => stableJson(a) === stableJson(b);
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function validateSha(value, label) {
  if (!SHA256_PATTERN.test(String(value || ""))) throw new Error(`${label} is not lowercase SHA-256`);
  return value;
}

function validateImplementationIdentity(identity, repositoryRoot, { requireCurrentAncestor = false } = {}) {
  exactKeys(identity, ["repository_head", "files"], "recovery implementation identity");
  if (!GIT_SHA1_PATTERN.test(String(identity.repository_head || "")) ||
      !Array.isArray(identity.files) || identity.files.length !== CODE_PATHS.length) {
    throw new Error("Recovery implementation identity is incomplete");
  }
  const paths = new Set();
  for (const [index, file] of identity.files.entries()) {
    exactKeys(file, ["path", "byte_size", "sha256"], `recovery implementation file ${index + 1}`);
    if (!CODE_PATHS.includes(file.path) || paths.has(file.path) || path.isAbsolute(file.path) ||
        file.path.split("/").includes("..") || !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0) {
      throw new Error(`Recovery implementation file ${index + 1} has an unsafe or unexpected identity`);
    }
    validateSha(file.sha256, `recovery implementation file ${file.path} SHA-256`);
    paths.add(file.path);
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `${identity.repository_head}:${file.path}`], {
        cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Recovery implementation Git object is unavailable for ${file.path}`, { cause: error });
    }
    if (bytes.byteLength !== file.byte_size || sha256(bytes) !== file.sha256) {
      throw new Error(`Recovery implementation file identity differs from its pinned Git tree: ${file.path}`);
    }
  }
  if (paths.size !== CODE_PATHS.length || CODE_PATHS.some((filePath) => !paths.has(filePath))) {
    throw new Error("Recovery implementation identity omits a required code file");
  }
  if (requireCurrentAncestor) {
    const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", identity.repository_head, currentHead], { cwd: repositoryRoot });
    } catch (error) {
      throw new Error("Previously approved recovery implementation is not an ancestor of current main", { cause: error });
    }
  }
  return identity;
}

export function getExceptionalRecoveryCodeIdentity(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const files = CODE_PATHS.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return { path: relativePath, byte_size: bytes.byteLength, sha256: sha256(bytes) };
  });
  return deepFreeze({ repository_head: head, files });
}

export function exceptionalRecoveryCodeSha256(identity) {
  return sha256(Buffer.from(stableJson(identity)));
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

function epochRoot(checkpointPath) {
  return `${path.resolve(checkpointPath)}${EPOCH_DIR_SUFFIX}`;
}

export function getExceptionalRecoveryJournalFrontier(journal) {
  const candidate = journal?.interrupted_append;
  return candidate
    ? Object.freeze({ sequence: candidate.sequence, entry_sha256: candidate.payload_sha256, interrupted_append: true })
    : Object.freeze({ sequence: journal.last_sequence, entry_sha256: journal.last_entry_sha256, interrupted_append: false });
}

function assertOwnedPrivateDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must be an owned private directory`);
  }
}

function approvedPhraseForEpoch(payload) {
  const runner = payload.runner;
  return `APPROVE EXCEPTIONAL UK-AQ LIVE V3 RESUME ${payload.migration_run_id} ` +
    `CHECKPOINT ${payload.original_checkpoint_sha256} AUTHORITY ${payload.immutable_authority_sha256} ` +
    `PLAN ${payload.plan_sha256} ORIGINAL_JOURNAL ${payload.original_journal_anchor.sequence} ${payload.original_journal_anchor.entry_sha256} ` +
    `JOURNAL_FRONTIER ${payload.journal_frontier.sequence} ${payload.journal_frontier.entry_sha256} ` +
    `RECOVERY_EPOCH ${payload.sequence} PREVIOUS_EPOCH ${payload.previous_epoch_sha256 || "NONE"} ` +
    `ORIGINAL_CODE ${EXCEPTIONAL_LIVE_RECOVERY.original_commit} NEW_CODE ${payload.recovery_implementation.repository_head} ${payload.recovery_implementation_sha256} ` +
    `SOURCE ${payload.source_root.key} ${payload.source_root.byte_size} ${payload.source_root.sha256} ` +
    `BUCKET ${payload.bucket} ACCOUNT ${payload.account_id} ` +
    `GCP ${runner.project_id} ${runner.zone} ${runner.machine_type} ` +
    `PROFILE ${runner.runner_profile} REPOSITORY UK-AQ/uk-aq-ops BRANCH main APPLY WRITERS_FROZEN\n`;
}

function readEpochLedger({ checkpointPath, journal, checkpointSha256, repositoryRoot }) {
  const root = epochRoot(checkpointPath);
  const currentFrontier = getExceptionalRecoveryJournalFrontier(journal);
  if (!fs.existsSync(root)) {
    if (currentFrontier.sequence !== EXCEPTIONAL_LIVE_RECOVERY.journal_sequence) {
      throw new Error("Exceptional journal progress beyond the original anchor has no recovery-epoch authority");
    }
    return Object.freeze({ root, entries: Object.freeze([]), sequence: 0, last_epoch_sha256: null,
      next_sequence: 1, previous_epoch_sha256: null });
  }
  assertOwnedPrivateDirectory(root, "Exceptional recovery epoch root");
  const entriesRoot = path.join(root, "entries");
  if (!fs.existsSync(entriesRoot)) throw new Error("Exceptional recovery epoch entries directory is missing");
  assertOwnedPrivateDirectory(entriesRoot, "Exceptional recovery epoch entries");
  const names = fs.readdirSync(entriesRoot).sort();
  const entries = [];
  const seenApprovals = new Set();
  const seenPhrases = new Set();
  let previousSha = null;
  let previousFrontier = EXCEPTIONAL_LIVE_RECOVERY.journal_sequence;
  let previousApprovedAt = 0;
  for (let index = 0; index < names.length; index += 1) {
    const sequence = index + 1;
    const name = names[index];
    const expectedName = `${String(sequence).padStart(10, "0")}.json`;
    if (name !== expectedName) throw new Error(`Exceptional recovery epoch sequence is missing or reordered before ${expectedName}`);
    const filePath = path.join(entriesRoot, name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Exceptional recovery epoch entry is unsafe: ${name}`);
    }
    const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
    exactKeys(envelope, ["schema_version", "kind", "payload", "payload_sha256"], `recovery epoch ${sequence}`);
    if (envelope.schema_version !== 1 || envelope.kind !== EPOCH_KIND) throw new Error(`Exceptional recovery epoch format is invalid at ${sequence}`);
    exactKeys(envelope.payload, [
      "sequence", "previous_epoch_sha256", "original_checkpoint_sha256", "immutable_authority_sha256",
      "migration_run_id", "plan_sha256", "original_journal_anchor", "journal_frontier",
      "recovery_implementation", "recovery_implementation_sha256", "approval_file_sha256",
      "approval_phrase", "approval_phrase_sha256", "approved_at_utc", "source_root", "bucket", "account_id", "runner",
    ], `recovery epoch ${sequence} payload`);
    if (envelope.payload_sha256 !== sha256(Buffer.from(stableJson(envelope.payload)))) throw new Error(`Exceptional recovery epoch SHA is invalid at ${sequence}`);
    const payload = envelope.payload;
    if (payload.sequence !== sequence || payload.previous_epoch_sha256 !== previousSha ||
        payload.original_checkpoint_sha256 !== checkpointSha256 ||
        payload.immutable_authority_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256 ||
        payload.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id || payload.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256) {
      throw new Error(`Exceptional recovery epoch identity or ancestry is contradictory at ${sequence}`);
    }
    exactKeys(payload.original_journal_anchor, ["sequence", "entry_sha256"], `recovery epoch ${sequence} original anchor`);
    if (payload.original_journal_anchor.sequence !== EXCEPTIONAL_LIVE_RECOVERY.journal_sequence ||
        payload.original_journal_anchor.entry_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256) {
      throw new Error(`Exceptional recovery epoch ${sequence} redefines the immutable original journal anchor`);
    }
    exactKeys(payload.journal_frontier, ["sequence", "entry_sha256"], `recovery epoch ${sequence} journal frontier`);
    const frontierSequence = payload.journal_frontier.sequence;
    if (!Number.isSafeInteger(frontierSequence) || frontierSequence < previousFrontier || frontierSequence > currentFrontier.sequence) {
      throw new Error(`Exceptional recovery epoch ${sequence} journal frontier is missing, reordered or outside the authenticated journal`);
    }
    const expectedFrontierSha = journal.entries[frontierSequence - 1]?.payload_sha256 || null;
    if (frontierSequence < 1 || payload.journal_frontier.entry_sha256 !== expectedFrontierSha) {
      throw new Error(`Exceptional recovery epoch ${sequence} frontier SHA is not present in the authenticated journal`);
    }
    if (sequence === 1 && (frontierSequence !== EXCEPTIONAL_LIVE_RECOVERY.journal_sequence ||
        payload.journal_frontier.entry_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256)) {
      throw new Error("First exceptional recovery epoch must start at the immutable original journal anchor");
    }
    previousFrontier = frontierSequence;
    const implementation = validateImplementationIdentity(payload.recovery_implementation, repositoryRoot, { requireCurrentAncestor: true });
    if (payload.recovery_implementation_sha256 !== exceptionalRecoveryCodeSha256(implementation)) {
      throw new Error(`Exceptional recovery epoch ${sequence} implementation digest is invalid`);
    }
    validateSha(payload.approval_file_sha256, `recovery epoch ${sequence} approval SHA-256`);
    validateSha(payload.approval_phrase_sha256, `recovery epoch ${sequence} approval phrase SHA-256`);
    if (typeof payload.approval_phrase !== "string" ||
        sha256(Buffer.from(payload.approval_phrase)) !== payload.approval_phrase_sha256 ||
        payload.approval_file_sha256 !== payload.approval_phrase_sha256 ||
        payload.approval_phrase !== approvedPhraseForEpoch(payload)) {
      throw new Error(`Exceptional recovery epoch ${sequence} does not retain its exact approved phrase`);
    }
    if (seenApprovals.has(payload.approval_file_sha256) || seenPhrases.has(payload.approval_phrase_sha256)) {
      throw new Error(`Exceptional recovery approval was reused at epoch ${sequence}`);
    }
    seenApprovals.add(payload.approval_file_sha256);
    seenPhrases.add(payload.approval_phrase_sha256);
    const approvedAt = Date.parse(payload.approved_at_utc);
    if (!Number.isFinite(approvedAt) || approvedAt < previousApprovedAt) throw new Error(`Exceptional recovery approval time is invalid at epoch ${sequence}`);
    previousApprovedAt = approvedAt;
    exactKeys(payload.source_root, ["key", "byte_size", "sha256"], `recovery epoch ${sequence} source root`);
    if (payload.source_root.key !== EXCEPTIONAL_LIVE_RECOVERY.source_root_key ||
        payload.source_root.byte_size !== 559 || payload.source_root.sha256 !== EXCEPTIONAL_LIVE_RECOVERY.source_root_sha256 ||
        payload.bucket !== "uk-aq-history-live" || payload.account_id !== "7e20426335c509cc77483210fa7ead0f") {
      throw new Error(`Exceptional recovery epoch ${sequence} source/bucket/account identity is invalid`);
    }
    exactKeys(payload.runner, ["runner_kind", "runner_profile", "project_id", "zone", "machine_type"], `recovery epoch ${sequence} runner`);
    if (payload.runner.runner_kind !== "gcp" || payload.runner.runner_profile !== "gcp-c4a-32" ||
        !/^[a-z][a-z0-9-]{5,62}$/.test(payload.runner.project_id) || !/^europe-west2-[a-z]$/.test(payload.runner.zone) ||
        payload.runner.machine_type !== "c4a-standard-32") throw new Error(`Exceptional recovery epoch ${sequence} GCP runner identity is invalid`);
    entries.push(Object.freeze({ sequence, payload_sha256: envelope.payload_sha256, payload }));
    previousSha = envelope.payload_sha256;
  }
  if (currentFrontier.sequence > EXCEPTIONAL_LIVE_RECOVERY.journal_sequence && entries.length === 0) {
    throw new Error("Exceptional journal progress beyond the original anchor has no recovery-epoch authority");
  }
  const last = entries.at(-1) || null;
  if (last && (currentFrontier.sequence < last.payload.journal_frontier.sequence ||
      (currentFrontier.sequence === last.payload.journal_frontier.sequence && currentFrontier.entry_sha256 !== last.payload.journal_frontier.entry_sha256))) {
    throw new Error("Authenticated journal frontier regresses behind the latest recovery epoch");
  }
  return Object.freeze({ root, entries: Object.freeze(entries), sequence: entries.length,
    last_epoch_sha256: previousSha, next_sequence: entries.length + 1, previous_epoch_sha256: previousSha });
}

export function authenticateExceptionalRecovery({ checkpointPath, repositoryRoot, authenticatedJournal = null,
  authenticatedCheckpoint = null, authenticatedCheckpointBytes = null, evidenceRoot = null }) {
  const absoluteCheckpoint = path.resolve(checkpointPath);
  const checkpointBytes = authenticatedCheckpointBytes || fs.readFileSync(absoluteCheckpoint);
  const checkpointSha256 = sha256(checkpointBytes);
  const checkpoint = authenticatedCheckpoint || JSON.parse(checkpointBytes.toString("utf8"));
  if (checkpoint.progress_format !== "authenticated-journal-v1" ||
      checkpoint.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id ||
      checkpoint.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
      checkpoint.authority_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256) {
    throw new Error("Exceptional recovery immutable checkpoint identity differs from the authorised run");
  }
  const journal = authenticatedJournal || inspectRecoveryJournalForInterruptedAppend({
    recoveryRoot: `${absoluteCheckpoint}.recovery`,
    expectedCheckpointSha256: checkpointSha256,
    expectedCheckpointByteSize: checkpointBytes.byteLength,
    expectedAuthoritySha256: EXCEPTIONAL_LIVE_RECOVERY.authority_sha256,
    expectedMigrationRunId: EXCEPTIONAL_LIVE_RECOVERY.run_id,
    expectedPlanSha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
    expectedTargetWriterGitSha: EXCEPTIONAL_LIVE_RECOVERY.original_commit,
  });
  if (!journal?.manifest?.payload || !Array.isArray(journal.entries) ||
      !journal.completed_objects || !Number.isSafeInteger(journal.last_sequence)) {
    throw new Error("Authenticated exceptional recovery journal is incomplete");
  }
  if (journal.manifest.payload.original_checkpoint.sha256 !== checkpointSha256 ||
      journal.manifest.payload.immutable_authority_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256 ||
      journal.manifest.payload.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id ||
      journal.manifest.payload.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
      journal.manifest.payload.target_writer_git_sha !== EXCEPTIONAL_LIVE_RECOVERY.original_commit) {
    throw new Error("Authenticated exceptional recovery manifest does not preserve the original migration identities");
  }
  const relocation = createEvidenceRelocation({
    historicalCheckpointPath: journal.manifest.payload.original_checkpoint.path,
    localCheckpointPath: absoluteCheckpoint,
    evidenceRoot,
  });
  if (checkpoint.authority_format === "uk_aq_migration_plan_shards_v1") {
    if (!checkpoint.authority) {
      const localReference = {
        ...checkpoint.authority_ref,
        master_path: relocation.mapHistoricalPath(checkpoint.authority_ref.master_path, "Exceptional recovery sharded plan master"),
      };
      const { plan } = readShardedMigrationPlan(localReference);
      checkpoint.authority = plan;
    }
    if (checkpoint.authority_ref.full_plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256 ||
        checkpoint.authority.plan_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.plan_sha256 ||
        checkpoint.authority.migration_run_id !== EXCEPTIONAL_LIVE_RECOVERY.run_id) {
      throw new Error("Exceptional recovery immutable sharded plan identity differs from the authorised run");
    }
  } else if (!checkpoint.authority || sha256StableMigrationJson(checkpoint.authority) !== EXCEPTIONAL_LIVE_RECOVERY.authority_sha256) {
    throw new Error("Exceptional recovery immutable inline plan identity differs from the authorised run");
  }
  const originalImplementation = verifyOriginalRecoveryImplementation({ manifest: journal.manifest, repositoryRoot });
  if (journal.manifest.payload.original_checkpoint.path !== relocation.historical_checkpoint_path) {
    throw new Error("Exceptional recovery checkpoint path differs from the authenticated original path");
  }
  if (journal.last_sequence < EXCEPTIONAL_LIVE_RECOVERY.journal_sequence ||
      journal.entries[EXCEPTIONAL_LIVE_RECOVERY.journal_sequence - 1]?.payload_sha256 !== EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256) {
    throw new Error("Original authenticated journal anchor is missing or changed");
  }
  const completedAtAnchor = [...journal.completed_objects.values()]
    .filter((entry) => entry.recovery_sequence <= EXCEPTIONAL_LIVE_RECOVERY.journal_sequence).length;
  const publicationsAtAnchor = journal.entries.slice(0, EXCEPTIONAL_LIVE_RECOVERY.journal_sequence)
    .reduce((total, entry) => total + (entry.payload.updates?.publication_evidence?.length || 0), 0);
  if (completedAtAnchor !== EXCEPTIONAL_LIVE_RECOVERY.authenticated_completed_objects ||
      publicationsAtAnchor !== EXCEPTIONAL_LIVE_RECOVERY.authenticated_v3_publications) {
    throw new Error("Original authenticated completion/publication counts differ from the independently recorded recovery anchor");
  }
  const recoveryEpoch = readEpochLedger({ checkpointPath: absoluteCheckpoint, journal, checkpointSha256, repositoryRoot });
  const currentImplementation = getExceptionalRecoveryCodeIdentity(repositoryRoot);
  return Object.freeze({ checkpoint, checkpointSha256, journal, originalImplementation, currentImplementation, recoveryEpoch });
}

function approvalContext({ auth, sourceRoot, codeSha, runner }) {
  if (sourceRoot?.key !== EXCEPTIONAL_LIVE_RECOVERY.source_root_key || sourceRoot?.byte_size !== 559 ||
      sourceRoot?.sha256 !== EXCEPTIONAL_LIVE_RECOVERY.source_root_sha256) {
    throw new Error("Current source-root identity differs from the authorised LIVE migration");
  }
  if (runner?.runner_kind !== "gcp" || runner?.runner_profile !== "gcp-c4a-32" || !runner.project_id ||
      !/^europe-west2-[a-z]$/.test(runner.zone) || runner.machine_type !== "c4a-standard-32") {
    throw new Error("Exceptional recovery approval requires the admitted LIVE GCP execution identity");
  }
  validateSha(codeSha, "Current recovery implementation SHA-256");
  return deepFreeze({
    original_checkpoint_sha256: auth.checkpointSha256,
    immutable_authority_sha256: EXCEPTIONAL_LIVE_RECOVERY.authority_sha256,
    migration_run_id: EXCEPTIONAL_LIVE_RECOVERY.run_id,
    plan_sha256: EXCEPTIONAL_LIVE_RECOVERY.plan_sha256,
    original_journal_anchor: { sequence: EXCEPTIONAL_LIVE_RECOVERY.journal_sequence, entry_sha256: EXCEPTIONAL_LIVE_RECOVERY.journal_head_sha256 },
    journal_frontier: (() => {
      const frontier = getExceptionalRecoveryJournalFrontier(auth.journal);
      return { sequence: frontier.sequence, entry_sha256: frontier.entry_sha256 };
    })(),
    next_epoch_sequence: auth.recoveryEpoch.next_sequence,
    previous_epoch_sha256: auth.recoveryEpoch.previous_epoch_sha256,
    recovery_implementation: auth.currentImplementation,
    recovery_implementation_sha256: codeSha,
    source_root: { key: sourceRoot.key, byte_size: sourceRoot.byte_size, sha256: sourceRoot.sha256 },
    bucket: "uk-aq-history-live",
    account_id: "7e20426335c509cc77483210fa7ead0f",
    runner: { runner_kind: runner.runner_kind, runner_profile: runner.runner_profile,
      project_id: runner.project_id, zone: runner.zone, machine_type: runner.machine_type },
  });
}

export function exceptionalRecoveryApprovalPhrase({ auth, sourceRoot, codeSha, codeHead, runner }) {
  const context = approvalContext({ auth, sourceRoot, codeSha, runner });
  if (context.recovery_implementation.repository_head !== codeHead) throw new Error("Recovery code HEAD changed during approval preparation");
  return `APPROVE EXCEPTIONAL UK-AQ LIVE V3 RESUME ${context.migration_run_id} ` +
    `CHECKPOINT ${context.original_checkpoint_sha256} AUTHORITY ${context.immutable_authority_sha256} ` +
    `PLAN ${context.plan_sha256} ORIGINAL_JOURNAL ${context.original_journal_anchor.sequence} ${context.original_journal_anchor.entry_sha256} ` +
    `JOURNAL_FRONTIER ${context.journal_frontier.sequence} ${context.journal_frontier.entry_sha256} ` +
    `RECOVERY_EPOCH ${context.next_epoch_sequence} PREVIOUS_EPOCH ${context.previous_epoch_sha256 || "NONE"} ` +
    `ORIGINAL_CODE ${auth.originalImplementation.repository_head} NEW_CODE ${codeHead} ${codeSha} ` +
    `SOURCE ${context.source_root.key} ${context.source_root.byte_size} ${context.source_root.sha256} ` +
    `BUCKET ${context.bucket} ACCOUNT ${context.account_id} ` +
    `GCP ${context.runner.project_id} ${context.runner.zone} ${context.runner.machine_type} ` +
    `PROFILE ${context.runner.runner_profile} REPOSITORY UK-AQ/uk-aq-ops BRANCH main APPLY WRITERS_FROZEN\n`;
}

export function validateExceptionalRecoveryApproval({ filePath, expectedPhrase, validFromMs, now = Date.now(), auth, sourceRoot, codeSha, runner }) {
  const approvalPath = path.resolve(filePath);
  const stat = fs.lstatSync(approvalPath);
  const bytes = fs.readFileSync(approvalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 || stat.size > 2048 || stat.mtimeMs < validFromMs ||
      now - stat.mtimeMs > 30 * 60 * 1000 || bytes.toString("utf8") !== expectedPhrase) {
    throw new Error("Exceptional recovery approval is stale, unsafe or does not match the exact authenticated run/code/journal identities");
  }
  const context = approvalContext({ auth, sourceRoot, codeSha, runner });
  return deepFreeze({
    kind: "uk_aq_observation_history_v3_exceptional_resume_approval_v1",
    approval_file_path: approvalPath,
    approved_at_utc: new Date(stat.mtimeMs).toISOString(),
    approval_file_sha256: sha256(bytes),
    approval_phrase: expectedPhrase,
    approval_phrase_sha256: sha256(Buffer.from(expectedPhrase)),
    approval_context: context,
  });
}

export function validateExceptionalRecoveryAdmission({ checkpointPath, repositoryRoot, approval, sourceRoot, runner }) {
  if (approval?.kind !== "uk_aq_observation_history_v3_exceptional_resume_approval_v1" ||
      !approval.approval_file_path || !SHA256_PATTERN.test(String(approval.approval_file_sha256 || ""))) {
    throw new Error("Exceptional recovery admission token is missing or malformed");
  }
  const auth = authenticateExceptionalRecovery({ checkpointPath, repositoryRoot });
  const currentCodeSha = exceptionalRecoveryCodeSha256(auth.currentImplementation);
  const phrase = exceptionalRecoveryApprovalPhrase({ auth, sourceRoot, codeSha: currentCodeSha,
    codeHead: auth.currentImplementation.repository_head, runner });
  const checked = validateExceptionalRecoveryApproval({ filePath: approval.approval_file_path,
    expectedPhrase: phrase, validFromMs: Date.now() - 30 * 60 * 1000, auth, sourceRoot,
    codeSha: currentCodeSha, runner });
  if (checked.approval_file_sha256 !== approval.approval_file_sha256 ||
      checked.approval_phrase_sha256 !== approval.approval_phrase_sha256 ||
      !equalStable(checked.approval_context, approval.approval_context)) {
    throw new Error("Exceptional recovery approval changed after initial operator admission");
  }
  return Object.freeze({
    [AUTHORIZATION_BRAND]: true,
    kind: "uk_aq_observation_history_v3_authenticated_exceptional_recovery_authority_v1",
    checkpoint_path: path.resolve(checkpointPath),
    repository_root: path.resolve(repositoryRoot),
    auth,
    approval: checked,
    source_root: deepFreeze({ ...checked.approval_context.source_root }),
    runner: deepFreeze({ runner_kind: runner.runner_kind, runner_profile: runner.runner_profile,
      project_id: runner.project_id, zone: runner.zone, machine_type: runner.machine_type }),
  });
}

export function isExceptionalRecoveryAuthorization(value) {
  return value?.[AUTHORIZATION_BRAND] === true &&
    value.kind === "uk_aq_observation_history_v3_authenticated_exceptional_recovery_authority_v1";
}

function durableDirectory(directory) {
  if (fs.existsSync(directory)) {
    assertOwnedPrivateDirectory(directory, "Exceptional recovery epoch directory");
    return;
  }
  fs.mkdirSync(directory, { mode: 0o700 });
  const parent = fs.openSync(path.dirname(directory), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function appendExceptionalRecoveryEpoch({ admission, assertLockHeld }) {
  if (!isExceptionalRecoveryAuthorization(admission) || typeof assertLockHeld !== "function") {
    throw new Error("Exceptional recovery epoch append requires authenticated authority and the held global lock");
  }
  assertLockHeld();
  const { auth, approval, source_root: sourceRoot, runner } = admission;
  const currentLedger = readEpochLedger({
    checkpointPath: admission.checkpoint_path,
    journal: auth.journal,
    checkpointSha256: auth.checkpointSha256,
    repositoryRoot: admission.repository_root,
  });
  if (currentLedger.sequence !== auth.recoveryEpoch.sequence ||
      currentLedger.last_epoch_sha256 !== auth.recoveryEpoch.last_epoch_sha256) {
    throw new Error("Exceptional recovery epoch ledger changed after operator approval");
  }
  const currentFrontier = getExceptionalRecoveryJournalFrontier(auth.journal);
  const frontier = { sequence: currentFrontier.sequence, entry_sha256: currentFrontier.entry_sha256 };
  const context = approval.approval_context;
  if (context.journal_frontier.sequence !== frontier.sequence || context.journal_frontier.entry_sha256 !== frontier.entry_sha256 ||
      context.next_epoch_sequence !== auth.recoveryEpoch.next_sequence ||
      context.previous_epoch_sha256 !== auth.recoveryEpoch.previous_epoch_sha256) {
    throw new Error("Exceptional recovery epoch approval no longer matches the authenticated journal/epoch frontier");
  }
  const payload = {
    sequence: context.next_epoch_sequence,
    previous_epoch_sha256: context.previous_epoch_sha256,
    original_checkpoint_sha256: context.original_checkpoint_sha256,
    immutable_authority_sha256: context.immutable_authority_sha256,
    migration_run_id: context.migration_run_id,
    plan_sha256: context.plan_sha256,
    original_journal_anchor: context.original_journal_anchor,
    journal_frontier: context.journal_frontier,
    recovery_implementation: context.recovery_implementation,
    recovery_implementation_sha256: context.recovery_implementation_sha256,
    approval_file_sha256: approval.approval_file_sha256,
    approval_phrase: approval.approval_phrase,
    approval_phrase_sha256: approval.approval_phrase_sha256,
    approved_at_utc: approval.approved_at_utc,
    source_root: sourceRoot,
    bucket: context.bucket,
    account_id: context.account_id,
    runner,
  };
  const envelope = { schema_version: 1, kind: EPOCH_KIND, payload,
    payload_sha256: sha256(Buffer.from(stableJson(payload))) };
  const root = epochRoot(admission.checkpoint_path);
  durableDirectory(root);
  const entriesRoot = path.join(root, "entries");
  durableDirectory(entriesRoot);
  const name = `${String(payload.sequence).padStart(10, "0")}.json`;
  const target = path.join(entriesRoot, name);
  if (fs.existsSync(target)) throw new Error(`Exceptional recovery epoch already exists: ${name}`);
  const temporary = path.join(entriesRoot, `${name}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, stableJson(envelope)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    const directoryFd = fs.openSync(entriesRoot, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  assertLockHeld();
  return Object.freeze({ sequence: payload.sequence, payload_sha256: envelope.payload_sha256,
    approval_file_sha256: payload.approval_file_sha256, recovery_implementation_sha256: payload.recovery_implementation_sha256 });
}
