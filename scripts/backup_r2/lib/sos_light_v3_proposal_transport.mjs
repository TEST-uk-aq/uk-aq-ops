import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT =
  "uk_aq_sos_light_v3_overlay_body_ref_v1";
export const SOS_LIGHT_V3_PROPOSAL_ARTIFACT_CONTRACT =
  "uk_aq_sos_light_v3_compact_proposal_artifact_v1";
export const SOS_LIGHT_V3_PROPOSAL_TRANSPORT_CONTRACT =
  "uk_aq_sos_light_v3_file_backed_transport_v1";

const SHA256 = /^[a-f0-9]{64}$/;

function safeRelativePath(raw, label) {
  const value = String(raw || "").trim().replace(/^\/+/, "");
  const parts = value.split("/");
  if (!value || path.isAbsolute(value)
      || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} is unsafe: ${String(raw)}`);
  }
  return parts.join("/");
}

function pathInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside its permitted run-local boundary`);
  }
  return { root: resolvedRoot, path: resolved, relative: relative.split(path.sep).join("/") };
}

function sha256Buffer(body) {
  return createHash("sha256").update(body).digest("hex");
}

function fileIdentity(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function atomicWrite(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.proposal-${process.pid}-${Date.now()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, "w", 0o600);
    let offset = 0;
    while (offset < body.byteLength) {
      const written = fs.writeSync(descriptor, body, offset, body.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error(`Proposal materialisation made no progress: ${filePath}`);
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporaryPath); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

function inlineProposalBody(proposal) {
  const value = proposal?.proposed_body ?? proposal?.body;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function expectedProposalIdentity(proposal, key) {
  const sha256 = String(proposal?.new_sha256 || "").trim().toLowerCase();
  const bytes = Number(proposal?.bytes);
  if (!SHA256.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Proposal body identity is invalid: ${key}`);
  }
  return { sha256, bytes };
}

function assertExactIdentity(actual, expected, key) {
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`Proposal body identity disagrees: ${key}`);
  }
}

function existingStagedPath({ runState, key, overlayRoot, expected }) {
  const entry = runState?.objects?.[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const localPath = String(entry.local_path || "");
  if (!localPath) return null;
  const resolved = pathInside(overlayRoot, localPath, `Existing staged body for ${key}`);
  const expectedPath = path.resolve(overlayRoot, ...key.split("/"));
  if (resolved.path !== expectedPath || fs.lstatSync(resolved.path, { throwIfNoEntry: false })?.isSymbolicLink()
      || !fs.statSync(resolved.path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Existing staged body path is invalid: ${key}`);
  }
  assertExactIdentity(fileIdentity(resolved.path), expected, key);
  return resolved;
}

export function materializeSosLightV3ProposalBodies({ output, overlayRoot, runState }) {
  const proposals = output?.planning?.proposals;
  if (!Array.isArray(proposals)) {
    throw new Error("Fixed-v3 proposal transport requires a proposals array");
  }
  if (!String(overlayRoot || "").trim()) {
    throw new Error("Fixed-v3 proposal transport overlay root is unavailable");
  }
  const resolvedOverlay = path.resolve(String(overlayRoot));
  if (!fs.statSync(resolvedOverlay, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Fixed-v3 proposal transport overlay root is unavailable");
  }
  let fileBackedBodyCount = 0;
  let fileBackedBodyBytes = 0;
  let fileBackedChangedBodyCount = 0;
  let fileBackedChangedBodyBytes = 0;
  for (const proposal of proposals) {
    const key = safeRelativePath(proposal?.key, "Proposal object key");
    const body = inlineProposalBody(proposal);
    const requiresBody = proposal?.changed === true || proposal?.included_in_write_set === true;
    if (requiresBody) {
      const expected = expectedProposalIdentity(proposal, key);
      let resolved = existingStagedPath({
        runState,
        key,
        overlayRoot: resolvedOverlay,
        expected,
      });
      if (!resolved) {
        if (!body) throw new Error(`Required proposal body is unavailable: ${key}`);
        assertExactIdentity({ sha256: sha256Buffer(body), bytes: body.byteLength }, expected, key);
        const target = path.resolve(resolvedOverlay, ...key.split("/"));
        resolved = pathInside(resolvedOverlay, target, `Materialised proposal body for ${key}`);
        atomicWrite(resolved.path, body);
        assertExactIdentity(fileIdentity(resolved.path), expected, key);
      }
      proposal.body_ref = Object.freeze({
        contract_version: SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
        source: "planned_overlay",
        relative_path: resolved.relative,
        sha256: expected.sha256,
        bytes: expected.bytes,
      });
      fileBackedBodyCount += 1;
      fileBackedBodyBytes += expected.bytes;
      if (proposal.changed === true) {
        fileBackedChangedBodyCount += 1;
        fileBackedChangedBodyBytes += expected.bytes;
      }
    }
    delete proposal.proposed_body;
    delete proposal.body;
  }
  const audit = Object.freeze({
    representation_mode: "compact_graph_with_run_local_overlay_body_refs",
    body_reference_contract_version: SOS_LIGHT_V3_BODY_REFERENCE_CONTRACT,
    proposal_count: proposals.length,
    file_backed_body_count: fileBackedBodyCount,
    file_backed_body_total_bytes: fileBackedBodyBytes,
    file_backed_changed_body_count: fileBackedChangedBodyCount,
    file_backed_changed_body_total_bytes: fileBackedChangedBodyBytes,
  });
  output.planning.proposal_transport = audit;
  return audit;
}

export function writeSosLightV3ProposalArtifact({ output, resultPath, runRoot }) {
  if (!String(runRoot || "").trim() || !String(resultPath || "").trim()) {
    throw new Error("Fixed-v3 proposal result path is unavailable");
  }
  const result = pathInside(runRoot, resultPath, "Fixed-v3 proposal result artifact");
  if (fs.lstatSync(result.path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Fixed-v3 proposal result artifact cannot be a symbolic link");
  }
  const artifact = {
    contract_version: SOS_LIGHT_V3_PROPOSAL_ARTIFACT_CONTRACT,
    kind: "uk_aq_sos_light_v3_compact_proposal",
    output,
  };
  const body = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  atomicWrite(result.path, body);
  const identity = fileIdentity(result.path);
  return Object.freeze({
    schema_version: 1,
    kind: "uk_aq_sos_light_v3_proposal_transport_envelope",
    transport_contract_version: SOS_LIGHT_V3_PROPOSAL_TRANSPORT_CONTRACT,
    transport_mode: "file_backed_compact_proposal",
    status: output?.ok === true ? "planned" : String(output?.status || "failed"),
    proposal_artifact: Object.freeze({
      relative_path: result.relative,
      sha256: identity.sha256,
      bytes: identity.bytes,
      contract_version: SOS_LIGHT_V3_PROPOSAL_ARTIFACT_CONTRACT,
    }),
    proposal_count: Array.isArray(output?.planning?.proposals)
      ? output.planning.proposals.length : 0,
    file_backed_changed_body_count:
      Number(output?.planning?.proposal_transport?.file_backed_changed_body_count || 0),
    file_backed_changed_body_total_bytes:
      Number(output?.planning?.proposal_transport?.file_backed_changed_body_total_bytes || 0),
  });
}
