#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECOVERY_ENTRY_KIND = "uk_aq_observation_history_v3_recovery_entry";
const RECOVERY_HEAD_KIND = "uk_aq_observation_history_v3_recovery_head";

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${filePath}`, { cause: error });
  }
}

function requireSha(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} is not lowercase SHA-256`);
  }
  return normalized;
}

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} is not a positive safe integer`);
  }
  return number;
}

function entryPath(entriesRoot, sequence) {
  return path.join(entriesRoot, `${String(sequence).padStart(10, "0")}.json`);
}

export function findPostMigrationCompletedObjectEvidence({
  recoveryRoot,
  sourceKey,
  expectedCheckpointSha256,
  expectedAuthoritySha256,
}) {
  const root = path.resolve(recoveryRoot);
  const headPath = path.join(root, "head.json");
  const entriesRoot = path.join(root, "entries");
  const head = readJson(headPath, "recovery head");

  if (head?.schema_version !== 1 || head?.kind !== RECOVERY_HEAD_KIND || !head.payload) {
    throw new Error("Recovery head schema/kind is invalid");
  }

  const checkpointSha = requireSha(expectedCheckpointSha256, "expected checkpoint SHA-256");
  const authoritySha = requireSha(expectedAuthoritySha256, "expected authority SHA-256");
  if (requireSha(head.payload.original_checkpoint_sha256, "head checkpoint SHA-256") !== checkpointSha) {
    throw new Error("Recovery head checkpoint identity differs from expected checkpoint");
  }
  if (requireSha(head.payload.immutable_authority_sha256, "head authority SHA-256") !== authoritySha) {
    throw new Error("Recovery head authority identity differs from expected authority");
  }

  let sequence = requirePositiveInteger(head.payload.last_sequence, "recovery head last_sequence");
  let expectedEntrySha = requireSha(head.payload.last_entry_sha256, "recovery head last_entry_sha256");
  let scannedEntries = 0;

  while (sequence > 0) {
    const filePath = entryPath(entriesRoot, sequence);
    const envelope = readJson(filePath, `recovery entry ${sequence}`);
    if (envelope?.schema_version !== 1 || envelope?.kind !== RECOVERY_ENTRY_KIND || !envelope.payload) {
      throw new Error(`Recovery entry schema/kind is invalid: ${filePath}`);
    }

    const computedPayloadSha = sha256(stableJson(envelope.payload));
    const recordedPayloadSha = requireSha(envelope.payload_sha256, `recovery entry ${sequence} payload_sha256`);
    if (computedPayloadSha !== recordedPayloadSha || recordedPayloadSha !== expectedEntrySha) {
      throw new Error(`Recovery journal chain/hash is invalid at sequence ${sequence}`);
    }
    if (Number(envelope.payload.sequence) !== sequence) {
      throw new Error(`Recovery journal sequence field mismatch at ${sequence}`);
    }
    if (
      requireSha(envelope.payload.original_checkpoint_sha256, `recovery entry ${sequence} checkpoint SHA-256`) !== checkpointSha ||
      requireSha(envelope.payload.immutable_authority_sha256, `recovery entry ${sequence} authority SHA-256`) !== authoritySha
    ) {
      throw new Error(`Recovery journal authority mismatch at sequence ${sequence}`);
    }

    scannedEntries += 1;
    const completedObjects = Array.isArray(envelope.payload?.updates?.completed_objects)
      ? envelope.payload.updates.completed_objects
      : [];
    for (const completed of completedObjects) {
      if (completed?.key !== sourceKey) continue;
      const evidence = completed?.evidence;
      if (!evidence || evidence.verified !== true || evidence.durable !== true) {
        throw new Error(`Post-migration source-root evidence is not verified and durable: ${sourceKey}`);
      }
      const byteSize = Number(evidence.byte_size);
      if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
        throw new Error(`Post-migration source-root byte size is invalid: ${sourceKey}`);
      }
      return Object.freeze({
        key: sourceKey,
        byte_size: byteSize,
        sha256: requireSha(evidence.sha256, "post-migration source-root SHA-256"),
        verified: true,
        durable: true,
        stored_sha256_verified: evidence.stored_sha256_verified === true,
        recovery_sequence: sequence,
        recovery_entry_payload_sha256: recordedPayloadSha,
        recovery_entries_scanned_from_head: scannedEntries,
      });
    }

    const previous = envelope.payload.previous_entry_sha256;
    if (sequence === 1) {
      if (previous !== null) {
        throw new Error("Recovery journal sequence 1 must have null previous_entry_sha256");
      }
    } else {
      expectedEntrySha = requireSha(previous, `recovery entry ${sequence} previous_entry_sha256`);
    }
    sequence -= 1;
  }

  throw new Error(`Post-migration completed-object evidence was not found for ${sourceKey}`);
}

function parseArgs(argv) {
  const args = {
    recoveryRoot: "",
    sourceKey: "",
    expectedCheckpointSha256: "",
    expectedAuthoritySha256: "",
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--recovery-root") args.recoveryRoot = String(argv[++index] || "");
    else if (flag === "--source-key") args.sourceKey = String(argv[++index] || "");
    else if (flag === "--expected-checkpoint-sha256") args.expectedCheckpointSha256 = String(argv[++index] || "");
    else if (flag === "--expected-authority-sha256") args.expectedAuthoritySha256 = String(argv[++index] || "");
    else if (flag === "--self-test") args.selfTest = true;
    else if (flag === "-h" || flag === "--help") {
      console.log("Usage: recovery_post_migration_root_evidence.mjs --recovery-root PATH --source-key KEY --expected-checkpoint-sha256 HEX --expected-authority-sha256 HEX");
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
    payload_sha256: sha256(stableJson(payload)),
  };
  fs.writeFileSync(filePath, JSON.stringify(envelope), "utf8");
  return envelope;
}

function selfTest() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-recovery-root-self-test-"));
  try {
    const recoveryRoot = path.join(temporary, "checkpoint.recovery");
    const entriesRoot = path.join(recoveryRoot, "entries");
    const checkpointSha = "1".repeat(64);
    const authoritySha = "2".repeat(64);
    const sourceKey = "history/v2/observations/_manifests/manifest.json";

    const firstPayload = {
      sequence: 1,
      previous_entry_sha256: null,
      original_checkpoint_sha256: checkpointSha,
      immutable_authority_sha256: authoritySha,
      updates: {
        completed_objects: [{
          key: sourceKey,
          evidence: {
            byte_size: 559,
            sha256: "3".repeat(64),
            verified: true,
            durable: true,
            stored_sha256_verified: true,
          },
        }],
      },
    };
    const first = writeEnvelope(entryPath(entriesRoot, 1), RECOVERY_ENTRY_KIND, firstPayload);
    const secondPayload = {
      sequence: 2,
      previous_entry_sha256: first.payload_sha256,
      original_checkpoint_sha256: checkpointSha,
      immutable_authority_sha256: authoritySha,
      updates: { final_state: { full_verification_complete: true, cutover_ready: true } },
    };
    const second = writeEnvelope(entryPath(entriesRoot, 2), RECOVERY_ENTRY_KIND, secondPayload);
    writeEnvelope(path.join(recoveryRoot, "head.json"), RECOVERY_HEAD_KIND, {
      original_checkpoint_sha256: checkpointSha,
      immutable_authority_sha256: authoritySha,
      last_sequence: 2,
      last_entry_sha256: second.payload_sha256,
    });

    const result = findPostMigrationCompletedObjectEvidence({
      recoveryRoot,
      sourceKey,
      expectedCheckpointSha256: checkpointSha,
      expectedAuthoritySha256: authoritySha,
    });
    if (
      result.sha256 !== "3".repeat(64) ||
      result.byte_size !== 559 ||
      result.recovery_sequence !== 1 ||
      result.recovery_entries_scanned_from_head !== 2
    ) {
      throw new Error("Self-test returned the wrong post-migration evidence");
    }

    const tampered = readJson(entryPath(entriesRoot, 2), "self-test entry");
    tampered.payload.updates = { final_state: { cutover_ready: false } };
    fs.writeFileSync(entryPath(entriesRoot, 2), JSON.stringify(tampered), "utf8");
    let rejected = false;
    try {
      findPostMigrationCompletedObjectEvidence({
        recoveryRoot,
        sourceKey,
        expectedCheckpointSha256: checkpointSha,
        expectedAuthoritySha256: authoritySha,
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Self-test accepted a tampered recovery-chain entry");

    console.log("PASS: post-migration source-root evidence is anchored to the recovery journal head");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) {
  selfTest();
} else {
  if (!args.recoveryRoot || !args.sourceKey || !args.expectedCheckpointSha256 || !args.expectedAuthoritySha256) {
    throw new Error("All recovery-root evidence arguments are required");
  }
  const result = findPostMigrationCompletedObjectEvidence(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
