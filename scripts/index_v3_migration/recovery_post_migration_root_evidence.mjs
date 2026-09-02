#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RECOVERY_ENTRY_KIND,
  RECOVERY_HEAD_KIND,
  RECOVERY_MANIFEST_KIND,
  readAndValidateRecoveryJournal,
  recoverySha256,
  requireRecoverySha,
  stableRecoveryJson,
} from "./recovery_journal_authority.mjs";

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not a positive safe integer`);
  }
  return value;
}

function entryPath(entriesRoot, sequence) {
  return path.join(entriesRoot, `${String(sequence).padStart(10, "0")}.json`);
}

export function findPostMigrationCompletedObjectEvidence({
  recoveryRoot,
  sourceKey,
  expectedCheckpointSha256,
  expectedCheckpointByteSize,
  expectedAuthoritySha256,
  expectedMigrationRunId,
  expectedPlanSha256,
  expectedTargetWriterGitSha,
}) {
  const key = String(sourceKey || "").trim();
  if (!key) throw new Error("Post-migration completed-object key is required");
  const replay = readAndValidateRecoveryJournal({
    recoveryRoot,
    expectedCheckpointSha256,
    expectedCheckpointByteSize,
    expectedAuthoritySha256,
    expectedMigrationRunId,
    expectedPlanSha256,
    expectedTargetWriterGitSha,
  });
  const completed = replay.completed_objects.get(key);
  if (!completed) throw new Error(`Post-migration completed-object evidence was not found for ${key}`);
  const evidence = completed.evidence;
  if (evidence.verified !== true || evidence.durable !== true) {
    throw new Error(`Post-migration completed-object evidence is not verified and durable: ${key}`);
  }
  const byteSize = requirePositiveInteger(evidence.byte_size, `Post-migration byte size for ${key}`);
  return Object.freeze({
    key,
    byte_size: byteSize,
    sha256: requireRecoverySha(evidence.sha256, `post-migration SHA-256 for ${key}`),
    verified: true,
    durable: true,
    stored_sha256_verified: evidence.stored_sha256_verified === true,
    recovery_sequence: completed.recovery_sequence,
    recovery_entry_payload_sha256: completed.recovery_entry_payload_sha256,
    recovery_entries_replayed: replay.last_sequence,
    recovery_head_payload_sha256: replay.head.payload_sha256,
    recovery_manifest_payload_sha256: replay.manifest.payload_sha256,
  });
}

function parseArgs(argv) {
  const args = {
    recoveryRoot: "",
    sourceKey: "",
    expectedCheckpointSha256: "",
    expectedCheckpointByteSize: undefined,
    expectedAuthoritySha256: "",
    expectedMigrationRunId: undefined,
    expectedPlanSha256: undefined,
    expectedTargetWriterGitSha: undefined,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--recovery-root") args.recoveryRoot = String(argv[++index] || "");
    else if (flag === "--source-key") args.sourceKey = String(argv[++index] || "");
    else if (flag === "--expected-checkpoint-sha256") args.expectedCheckpointSha256 = String(argv[++index] || "");
    else if (flag === "--expected-checkpoint-byte-size") args.expectedCheckpointByteSize = Number(argv[++index]);
    else if (flag === "--expected-authority-sha256") args.expectedAuthoritySha256 = String(argv[++index] || "");
    else if (flag === "--expected-migration-run-id") args.expectedMigrationRunId = String(argv[++index] || "");
    else if (flag === "--expected-plan-sha256") args.expectedPlanSha256 = String(argv[++index] || "");
    else if (flag === "--expected-target-writer-git-sha") args.expectedTargetWriterGitSha = String(argv[++index] || "");
    else if (flag === "--self-test") args.selfTest = true;
    else if (flag === "-h" || flag === "--help") {
      console.log("Usage: recovery_post_migration_root_evidence.mjs --recovery-root PATH --source-key KEY --expected-checkpoint-sha256 HEX --expected-checkpoint-byte-size BYTES --expected-authority-sha256 HEX --expected-migration-run-id ID --expected-plan-sha256 HEX --expected-target-writer-git-sha HEX");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function writeEnvelope(filePath, kind, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const envelope = {
    schema_version: 1,
    kind,
    payload,
    payload_sha256: recoverySha256(stableRecoveryJson(payload)),
  };
  fs.writeFileSync(filePath, JSON.stringify(envelope), "utf8");
  return envelope;
}

function readFixtureJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rewriteEnvelope(filePath, update) {
  const current = readFixtureJson(filePath);
  update(current);
  current.payload_sha256 = recoverySha256(stableRecoveryJson(current.payload));
  fs.writeFileSync(filePath, JSON.stringify(current), "utf8");
  return current;
}

function buildValidFixture(root) {
  const recoveryRoot = path.join(root, "checkpoint.recovery");
  const entriesRoot = path.join(recoveryRoot, "entries");
  const identity = {
    checkpointSha: "1".repeat(64),
    checkpointByteSize: 777,
    authoritySha: "2".repeat(64),
    planSha: "3".repeat(64),
    targetWriterGitSha: "4".repeat(40),
    migrationRunId: "fixture-run",
    sourceKey: "history/v2/observations/_manifests/manifest.json",
  };
  writeEnvelope(path.join(recoveryRoot, "manifest.json"), RECOVERY_MANIFEST_KIND, {
    original_checkpoint: {
      path: "/operator/checkpoint.json",
      byte_size: identity.checkpointByteSize,
      sha256: identity.checkpointSha,
    },
    immutable_authority_sha256: identity.authoritySha,
    migration_run_id: identity.migrationRunId,
    transition: {
      kind: "v2-to-v3",
      source_index_generation: "v2",
      target_index_generation: "v3",
      authority_switch_required: true,
    },
    plan_sha256: identity.planSha,
    target_writer_git_sha: identity.targetWriterGitSha,
    recovery_implementation: {
      repository_head: "5".repeat(40),
      files: [{ path: "scripts/recover.mjs", byte_size: 10, sha256: "6".repeat(64) }],
    },
  });
  const first = writeEnvelope(entryPath(entriesRoot, 1), RECOVERY_ENTRY_KIND, {
    sequence: 1,
    previous_entry_sha256: null,
    original_checkpoint_sha256: identity.checkpointSha,
    immutable_authority_sha256: identity.authoritySha,
    updates: {
      completed_objects: [{
        key: `${identity.sourceKey}.prior-fixture-object`,
        evidence: { byte_size: 100, sha256: "7".repeat(64), verified: true, durable: true },
      }],
    },
  });
  const second = writeEnvelope(entryPath(entriesRoot, 2), RECOVERY_ENTRY_KIND, {
    sequence: 2,
    previous_entry_sha256: first.payload_sha256,
    original_checkpoint_sha256: identity.checkpointSha,
    immutable_authority_sha256: identity.authoritySha,
    updates: {
      completed_objects: [{
        key: identity.sourceKey,
        evidence: { byte_size: 559, sha256: "8".repeat(64), verified: true, durable: true },
      }],
      final_state: { full_verification_complete: true, cutover_ready: true },
    },
  });
  writeEnvelope(path.join(recoveryRoot, "head.json"), RECOVERY_HEAD_KIND, {
    original_checkpoint_sha256: identity.checkpointSha,
    immutable_authority_sha256: identity.authoritySha,
    last_sequence: 2,
    last_entry_sha256: second.payload_sha256,
  });
  return { recoveryRoot, entriesRoot, identity };
}

function fixtureArgs(fixture) {
  return {
    recoveryRoot: fixture.recoveryRoot,
    sourceKey: fixture.identity.sourceKey,
    expectedCheckpointSha256: fixture.identity.checkpointSha,
    expectedCheckpointByteSize: fixture.identity.checkpointByteSize,
    expectedAuthoritySha256: fixture.identity.authoritySha,
    expectedMigrationRunId: fixture.identity.migrationRunId,
    expectedPlanSha256: fixture.identity.planSha,
    expectedTargetWriterGitSha: fixture.identity.targetWriterGitSha,
  };
}

function expectRejected(baseRoot, identity, name, mutate) {
  const root = path.join(path.dirname(baseRoot), name);
  fs.cpSync(baseRoot, root, { recursive: true });
  const fixture = { recoveryRoot: root, entriesRoot: path.join(root, "entries") };
  mutate(fixture);
  let rejected = false;
  try {
    findPostMigrationCompletedObjectEvidence({
      ...fixtureArgs({ recoveryRoot: root, identity }),
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`Self-test accepted ${name}`);
}

function selfTest() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-recovery-authority-self-test-"));
  try {
    const fixture = buildValidFixture(path.join(temporary, "valid"));
    const result = findPostMigrationCompletedObjectEvidence(fixtureArgs(fixture));
    if (
      result.sha256 !== "8".repeat(64) ||
      result.byte_size !== 559 ||
      result.recovery_sequence !== 2 ||
      result.recovery_entries_replayed !== 2
    ) {
      throw new Error("Valid complete-chain fixture did not return latest authoritative evidence");
    }

    expectRejected(fixture.recoveryRoot, fixture.identity, "corrupted-entry-payload", ({ entriesRoot }) => {
      const target = entryPath(entriesRoot, 2);
      const envelope = readFixtureJson(target);
      envelope.payload.updates.final_state.cutover_ready = false;
      fs.writeFileSync(target, JSON.stringify(envelope), "utf8");
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "corrupted-head-payload-hash", ({ recoveryRoot }) => {
      const target = path.join(recoveryRoot, "head.json");
      const envelope = readFixtureJson(target);
      envelope.payload_sha256 = "9".repeat(64);
      fs.writeFileSync(target, JSON.stringify(envelope), "utf8");
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "truncated-head", ({ entriesRoot }) => {
      fs.unlinkSync(entryPath(entriesRoot, 2));
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "missing-sequence", ({ entriesRoot, recoveryRoot }) => {
      fs.renameSync(entryPath(entriesRoot, 2), entryPath(entriesRoot, 3));
      const third = rewriteEnvelope(entryPath(entriesRoot, 3), (entry) => { entry.payload.sequence = 3; });
      rewriteEnvelope(path.join(recoveryRoot, "head.json"), (head) => {
        head.payload.last_sequence = 3;
        head.payload.last_entry_sha256 = third.payload_sha256;
      });
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "extra-entry-beyond-head", ({ entriesRoot }) => {
      const second = readFixtureJson(entryPath(entriesRoot, 2));
      writeEnvelope(entryPath(entriesRoot, 3), RECOVERY_ENTRY_KIND, {
        sequence: 3,
        previous_entry_sha256: second.payload_sha256,
        original_checkpoint_sha256: fixture.identity.checkpointSha,
        immutable_authority_sha256: fixture.identity.authoritySha,
        updates: {},
      });
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "broken-ancestry", ({ entriesRoot, recoveryRoot }) => {
      const second = rewriteEnvelope(entryPath(entriesRoot, 2), (entry) => {
        entry.payload.previous_entry_sha256 = "9".repeat(64);
      });
      rewriteEnvelope(path.join(recoveryRoot, "head.json"), (head) => {
        head.payload.last_entry_sha256 = second.payload_sha256;
      });
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "wrong-checkpoint", ({ entriesRoot, recoveryRoot }) => {
      const second = rewriteEnvelope(entryPath(entriesRoot, 2), (entry) => {
        entry.payload.original_checkpoint_sha256 = "9".repeat(64);
      });
      rewriteEnvelope(path.join(recoveryRoot, "head.json"), (head) => {
        head.payload.last_entry_sha256 = second.payload_sha256;
      });
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "wrong-immutable-authority", ({ entriesRoot, recoveryRoot }) => {
      const second = rewriteEnvelope(entryPath(entriesRoot, 2), (entry) => {
        entry.payload.immutable_authority_sha256 = "9".repeat(64);
      });
      rewriteEnvelope(path.join(recoveryRoot, "head.json"), (head) => {
        head.payload.last_entry_sha256 = second.payload_sha256;
      });
    });
    expectRejected(fixture.recoveryRoot, fixture.identity, "malformed-recovery-manifest", ({ recoveryRoot }) => {
      rewriteEnvelope(path.join(recoveryRoot, "manifest.json"), (manifest) => {
        manifest.payload.implementation = manifest.payload.recovery_implementation;
        delete manifest.payload.recovery_implementation;
      });
    });
    console.log("PASS: strict recovery authentication rejected all deterministic corruption fixtures");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.selfTest) {
    selfTest();
    return;
  }
  const required = [
    args.recoveryRoot,
    args.sourceKey,
    args.expectedCheckpointSha256,
    args.expectedCheckpointByteSize,
    args.expectedAuthoritySha256,
    args.expectedMigrationRunId,
    args.expectedPlanSha256,
    args.expectedTargetWriterGitSha,
  ];
  if (required.some((value) => value === "" || value === undefined || Number.isNaN(value))) {
    throw new Error("All recovery authority arguments are required");
  }
  process.stdout.write(`${JSON.stringify(findPostMigrationCompletedObjectEvidence(args))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
