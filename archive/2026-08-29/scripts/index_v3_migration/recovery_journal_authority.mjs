import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RECOVERY_ENTRY_KIND = "uk_aq_observation_history_v3_recovery_entry";
export const RECOVERY_HEAD_KIND = "uk_aq_observation_history_v3_recovery_head";
export const RECOVERY_MANIFEST_KIND = "uk_aq_observation_history_v3_recovery_manifest";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableObject(value[key])]),
    );
  }
  return value;
}

export function stableRecoveryJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

export function recoverySha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${filePath}`, { cause: error });
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(requirePlainObject(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

export function requireRecoverySha(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} is not lowercase SHA-256`);
  return normalized;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is empty or invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is not a positive safe integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function readEnvelope(filePath, expectedKind, label) {
  const envelope = readJson(filePath, label);
  requireExactKeys(envelope, ["schema_version", "kind", "payload", "payload_sha256"], label);
  if (envelope.schema_version !== 1 || envelope.kind !== expectedKind) {
    throw new Error(`${label} schema/kind is invalid`);
  }
  requirePlainObject(envelope.payload, `${label} payload`);
  const recorded = requireRecoverySha(envelope.payload_sha256, `${label} payload_sha256`);
  const computed = recoverySha256(stableRecoveryJson(envelope.payload));
  if (recorded !== computed) throw new Error(`${label} payload SHA-256 is invalid`);
  return envelope;
}

function validateManifestPayload(payload) {
  requireExactKeys(payload, [
    "original_checkpoint",
    "immutable_authority_sha256",
    "migration_run_id",
    "plan_sha256",
    "target_writer_git_sha",
    "recovery_implementation",
  ], "recovery manifest payload");
  requireExactKeys(payload.original_checkpoint, ["path", "byte_size", "sha256"], "recovery manifest original_checkpoint");
  requireNonEmptyString(payload.original_checkpoint.path, "recovery manifest checkpoint path");
  requirePositiveInteger(payload.original_checkpoint.byte_size, "recovery manifest checkpoint byte_size");
  requireRecoverySha(payload.original_checkpoint.sha256, "recovery manifest checkpoint SHA-256");
  requireRecoverySha(payload.immutable_authority_sha256, "recovery manifest authority SHA-256");
  requireNonEmptyString(payload.migration_run_id, "recovery manifest migration_run_id");
  requireRecoverySha(payload.plan_sha256, "recovery manifest plan SHA-256");
  if (!GIT_SHA1_PATTERN.test(String(payload.target_writer_git_sha || ""))) {
    throw new Error("recovery manifest target_writer_git_sha is invalid");
  }
  requireExactKeys(payload.recovery_implementation, ["repository_head", "files"], "recovery implementation");
  if (!GIT_SHA1_PATTERN.test(String(payload.recovery_implementation.repository_head || ""))) {
    throw new Error("recovery implementation repository_head is invalid");
  }
  if (!Array.isArray(payload.recovery_implementation.files) || payload.recovery_implementation.files.length === 0) {
    throw new Error("recovery implementation files are missing");
  }
  const paths = new Set();
  for (const [index, file] of payload.recovery_implementation.files.entries()) {
    const label = `recovery implementation file ${index + 1}`;
    requireExactKeys(file, ["path", "byte_size", "sha256"], label);
    const filePath = requireNonEmptyString(file.path, `${label} path`);
    if (path.isAbsolute(filePath) || filePath.split("/").includes("..") || paths.has(filePath)) {
      throw new Error(`${label} path is unsafe or duplicated`);
    }
    paths.add(filePath);
    requirePositiveInteger(file.byte_size, `${label} byte_size`);
    requireRecoverySha(file.sha256, `${label} SHA-256`);
  }
}

function validateExpectedIdentity(actual, expected, label) {
  if (expected === undefined || expected === null || expected === "") return;
  if (actual !== expected) throw new Error(`${label} differs from independently expected identity`);
}

export function readAndValidateRecoveryJournal({
  recoveryRoot,
  expectedCheckpointSha256,
  expectedCheckpointByteSize,
  expectedAuthoritySha256,
  expectedMigrationRunId,
  expectedPlanSha256,
  expectedTargetWriterGitSha,
  allowEmpty = false,
}) {
  const root = path.resolve(recoveryRoot);
  const manifestPath = path.join(root, "manifest.json");
  const headPath = path.join(root, "head.json");
  const entriesRoot = path.join(root, "entries");
  const manifest = readEnvelope(manifestPath, RECOVERY_MANIFEST_KIND, "recovery manifest");
  validateManifestPayload(manifest.payload);

  const checkpointSha = requireRecoverySha(
    expectedCheckpointSha256,
    "independently expected checkpoint SHA-256",
  );
  const authoritySha = requireRecoverySha(
    expectedAuthoritySha256,
    "independently expected authority SHA-256",
  );
  validateExpectedIdentity(manifest.payload.original_checkpoint.sha256, checkpointSha, "recovery manifest checkpoint");
  validateExpectedIdentity(manifest.payload.immutable_authority_sha256, authoritySha, "recovery manifest authority");
  if (expectedCheckpointByteSize !== undefined) {
    requirePositiveInteger(expectedCheckpointByteSize, "independently expected checkpoint byte_size");
    validateExpectedIdentity(
      manifest.payload.original_checkpoint.byte_size,
      expectedCheckpointByteSize,
      "recovery manifest checkpoint byte_size",
    );
  }
  validateExpectedIdentity(manifest.payload.migration_run_id, expectedMigrationRunId, "recovery manifest migration_run_id");
  validateExpectedIdentity(manifest.payload.plan_sha256, expectedPlanSha256, "recovery manifest plan SHA-256");
  validateExpectedIdentity(
    manifest.payload.target_writer_git_sha,
    expectedTargetWriterGitSha,
    "recovery manifest target writer Git SHA",
  );

  const head = readEnvelope(headPath, RECOVERY_HEAD_KIND, "recovery head");
  requireExactKeys(head.payload, [
    "original_checkpoint_sha256",
    "immutable_authority_sha256",
    "last_sequence",
    "last_entry_sha256",
  ], "recovery head payload");
  if (requireRecoverySha(head.payload.original_checkpoint_sha256, "head checkpoint SHA-256") !== checkpointSha) {
    throw new Error("Recovery head checkpoint identity differs from independently expected checkpoint");
  }
  if (requireRecoverySha(head.payload.immutable_authority_sha256, "head authority SHA-256") !== authoritySha) {
    throw new Error("Recovery head authority identity differs from independently expected authority");
  }
  const lastSequence = requireNonNegativeInteger(head.payload.last_sequence, "recovery head last_sequence");
  if (!allowEmpty && lastSequence === 0) throw new Error("Recovery journal is empty");
  const lastEntrySha = lastSequence === 0
    ? (head.payload.last_entry_sha256 === null
      ? null
      : (() => { throw new Error("Empty recovery head must have null last_entry_sha256"); })())
    : requireRecoverySha(head.payload.last_entry_sha256, "recovery head last_entry_sha256");

  if (!fs.existsSync(entriesRoot) || !fs.statSync(entriesRoot).isDirectory()) {
    throw new Error(`Recovery entries directory is missing: ${entriesRoot}`);
  }
  const names = fs.readdirSync(entriesRoot).sort();
  for (const name of names) {
    if (!/^\d{10}\.json$/.test(name)) throw new Error(`Unexpected recovery entry filename: ${name}`);
  }
  if (names.length !== lastSequence) {
    throw new Error("Recovery entry count does not exactly match the claimed head sequence");
  }

  const entries = [];
  const completedObjects = new Map();
  let previousEntrySha = null;
  for (let sequence = 1; sequence <= lastSequence; sequence += 1) {
    const expectedName = `${String(sequence).padStart(10, "0")}.json`;
    if (names[sequence - 1] !== expectedName) {
      throw new Error(`Recovery journal sequence is missing before ${expectedName}`);
    }
    const envelope = readEnvelope(
      path.join(entriesRoot, expectedName),
      RECOVERY_ENTRY_KIND,
      `recovery entry ${sequence}`,
    );
    requireExactKeys(envelope.payload, [
      "sequence",
      "previous_entry_sha256",
      "original_checkpoint_sha256",
      "immutable_authority_sha256",
      "updates",
    ], `recovery entry ${sequence} payload`);
    if (envelope.payload.sequence !== sequence) {
      throw new Error(`Recovery journal sequence field mismatch at ${sequence}`);
    }
    if (envelope.payload.previous_entry_sha256 !== previousEntrySha) {
      throw new Error(`Recovery journal ancestry is invalid at sequence ${sequence}`);
    }
    if (
      requireRecoverySha(envelope.payload.original_checkpoint_sha256, `recovery entry ${sequence} checkpoint SHA-256`) !== checkpointSha
    ) {
      throw new Error(`Recovery journal checkpoint identity mismatch at sequence ${sequence}`);
    }
    if (
      requireRecoverySha(envelope.payload.immutable_authority_sha256, `recovery entry ${sequence} authority SHA-256`) !== authoritySha
    ) {
      throw new Error(`Recovery journal immutable authority mismatch at sequence ${sequence}`);
    }
    requirePlainObject(envelope.payload.updates, `recovery entry ${sequence} updates`);
    const updates = envelope.payload.updates;
    if (updates.completed_objects !== undefined) {
      if (!Array.isArray(updates.completed_objects)) {
        throw new Error(`Recovery completed_objects is invalid at sequence ${sequence}`);
      }
      const entryKeys = new Set();
      for (const completed of updates.completed_objects) {
        requireExactKeys(completed, ["key", "evidence"], `recovery completed object at sequence ${sequence}`);
        const key = requireNonEmptyString(completed.key, `recovery completed object key at sequence ${sequence}`);
        if (entryKeys.has(key)) throw new Error(`Recovery entry ${sequence} contains duplicate completed object ${key}`);
        entryKeys.add(key);
        requirePlainObject(completed.evidence, `recovery completed object evidence at sequence ${sequence}`);
        completedObjects.set(key, Object.freeze({
          evidence: completed.evidence,
          recovery_sequence: sequence,
          recovery_entry_payload_sha256: envelope.payload_sha256,
        }));
      }
    }
    entries.push(Object.freeze({
      sequence,
      payload_sha256: envelope.payload_sha256,
      payload: envelope.payload,
    }));
    previousEntrySha = envelope.payload_sha256;
  }
  if (previousEntrySha !== lastEntrySha) {
    throw new Error("Recovery head terminal entry SHA does not equal the final enumerated entry");
  }

  return Object.freeze({
    root,
    manifest,
    head,
    entries: Object.freeze(entries),
    completed_objects: completedObjects,
    last_sequence: lastSequence,
    last_entry_sha256: lastEntrySha,
  });
}
