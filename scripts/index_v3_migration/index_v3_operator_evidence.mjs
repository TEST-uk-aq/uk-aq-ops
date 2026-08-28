#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_NAME = /^(?!-)(?!.*-$)[a-z0-9-]+$/;
const KINDS = new Set([
  "uk_aq_index_v3_writer_freeze_evidence",
  "uk_aq_index_v3_v2_runtime_rollback_record",
]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
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
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${filePath}`, { cause: error });
  }
}

function plain(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(plain(value, label)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is empty or invalid`);
  return value;
}

function timestamp(value, label) {
  const raw = string(value, label);
  if (Number.isNaN(Date.parse(raw))) throw new Error(`${label} is not an ISO timestamp`);
  return raw;
}

function requireSha(value, label, pattern = SHA256) {
  const raw = String(value || "");
  if (!pattern.test(raw)) throw new Error(`${label} is invalid`);
  return raw;
}

function assertNoSecrets(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, [...pathParts, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/(secret|token|password|credential|private[_-]?key)/i.test(key)) {
      throw new Error(`Operator evidence contains prohibited secret-like field: ${[...pathParts, key].join(".")}`);
    }
    assertNoSecrets(entry, [...pathParts, key]);
  }
}

function gitBlobSha256(repositoryRoot, commit, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`Evidence artifact path is unsafe: ${relativePath}`);
  }
  const result = spawnSync("git", ["cat-file", "blob", `${commit}:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Git artifact is unavailable: ${commit}:${relativePath}`);
  return sha256(result.stdout);
}

function validateGitArtifact(artifact, repositoryRoot, label) {
  exactKeys(artifact, ["role", "path", "git_commit_sha", "sha256"], label);
  string(artifact.role, `${label} role`);
  const relativePath = string(artifact.path, `${label} path`);
  const commit = requireSha(artifact.git_commit_sha, `${label} git_commit_sha`, GIT_SHA);
  const expected = requireSha(artifact.sha256, `${label} sha256`);
  const actual = gitBlobSha256(repositoryRoot, commit, relativePath);
  if (actual !== expected) throw new Error(`${label} does not match its pinned Git blob`);
}

function validateRepository(payload, repositoryRoot, label) {
  string(payload.repository, `${label} repository`);
  string(payload.branch, `${label} branch`);
  const head = requireSha(payload.repository_head, `${label} repository_head`, GIT_SHA);
  const commit = spawnSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: repositoryRoot });
  if (commit.status !== 0) throw new Error(`${label} repository_head is unavailable in Git`);
}

function validateWriterFreezePayload(payload, { repositoryRoot, planReport }) {
  exactKeys(payload, [
    "environment", "repository", "branch", "repository_head", "migration_run_id",
    "plan_sha256", "confirmed_at_utc", "operator", "resume_boundary", "entries",
  ], "writer-freeze payload");
  if (!new Set(["TEST", "LIVE"]).has(string(payload.environment, "writer-freeze environment").toUpperCase())) {
    throw new Error("writer-freeze environment must be TEST or LIVE");
  }
  validateRepository(payload, repositoryRoot, "writer-freeze");
  string(payload.migration_run_id, "writer-freeze migration_run_id");
  requireSha(payload.plan_sha256, "writer-freeze plan_sha256");
  timestamp(payload.confirmed_at_utc, "writer-freeze confirmed_at_utc");
  string(payload.operator, "writer-freeze operator");
  if (payload.resume_boundary !== "accepted_v3_cutover_or_completed_v2_rollback") {
    throw new Error("writer-freeze resume_boundary is invalid");
  }
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) throw new Error("writer-freeze entries are missing");
  const expectedPlan = plain(planReport?.result?.writer_freeze_plan, "plan writer_freeze_plan");
  const expectedEntries = Array.isArray(expectedPlan.entries) ? expectedPlan.entries : [];
  if (payload.migration_run_id !== planReport.result.migration_run_id || payload.plan_sha256 !== planReport.result.plan_sha256) {
    throw new Error("writer-freeze evidence does not match the migration plan identity");
  }
  const actualIds = payload.entries.map((entry) => entry.id).sort();
  const expectedIds = expectedEntries.map((entry) => entry.id).sort();
  if (stableJson(actualIds) !== stableJson(expectedIds)) throw new Error("writer-freeze evidence does not cover exactly the declared mutation classes");
  for (const expected of expectedEntries) {
    const entry = payload.entries.find((candidate) => candidate.id === expected.id);
    exactKeys(entry, ["id", "control", "frozen", "operator_assertion", "entrypoints"], `writer-freeze entry ${expected.id}`);
    const expectedControl = expected.kind === "scheduled_workflow" ? "scheduler_and_workflow" : "manual_operator_freeze";
    if (entry.control !== expectedControl || entry.frozen !== true) {
      throw new Error(`writer-freeze control is invalid for ${expected.id}`);
    }
    string(entry.operator_assertion, `writer-freeze ${expected.id} operator_assertion`);
    if (!Array.isArray(entry.entrypoints)) throw new Error(`writer-freeze entrypoints are missing for ${expected.id}`);
    const expectedPaths = [...expected.evidence_files].sort();
    const actualPaths = entry.entrypoints.map((artifact) => artifact.path).sort();
    if (stableJson(actualPaths) !== stableJson(expectedPaths)) {
      throw new Error(`writer-freeze entrypoints differ from the declared plan for ${expected.id}`);
    }
    entry.entrypoints.forEach((artifact) => validateGitArtifact(artifact, repositoryRoot, `writer-freeze ${expected.id} artifact`));
  }
}

function validateRollbackPayload(payload, { repositoryRoot }) {
  exactKeys(payload, [
    "environment", "repository", "branch", "repository_head", "recorded_at_utc",
    "history_version", "index_authority_generation", "integrity_version", "components",
    "artifacts", "restore_steps",
  ], "v2 runtime rollback payload");
  if (!new Set(["TEST", "LIVE"]).has(string(payload.environment, "rollback environment").toUpperCase())) {
    throw new Error("rollback environment must be TEST or LIVE");
  }
  validateRepository(payload, repositoryRoot, "v2 runtime rollback");
  timestamp(payload.recorded_at_utc, "rollback recorded_at_utc");
  if (payload.history_version !== "v2" || payload.index_authority_generation !== "v2") {
    throw new Error("rollback record must identify logical history v2 and observation index authority v2");
  }
  string(payload.integrity_version, "rollback integrity_version");
  if (!Array.isArray(payload.components)) throw new Error("rollback components are missing");
  const requiredRoles = new Set(["stable_observations_worker", "stable_station_worker", "cache_worker"]);
  const roles = new Set();
  for (const component of payload.components) {
    exactKeys(component, ["role", "worker_name", "git_commit_sha", "deployment"], "rollback component");
    const role = string(component.role, "rollback component role");
    if (roles.has(role)) throw new Error(`rollback component role is duplicated: ${role}`);
    roles.add(role);
    const worker = string(component.worker_name, `rollback ${role} worker_name`);
    if (!WORKER_NAME.test(worker) || worker.endsWith("-v3-candidate") || worker.length > 63) {
      throw new Error(`rollback ${role} stable Worker name is invalid`);
    }
    const componentCommit = requireSha(component.git_commit_sha, `rollback ${role} git_commit_sha`, GIT_SHA);
    const commit = spawnSync("git", ["cat-file", "-e", `${componentCommit}^{commit}`], { cwd: repositoryRoot });
    if (commit.status !== 0) throw new Error(`rollback ${role} git commit is unavailable`);
    exactKeys(component.deployment, ["version_id", "deployment_id", "captured_by"], `rollback ${role} deployment`);
    if (!UUID.test(string(component.deployment.version_id, `rollback ${role} version_id`))) {
      throw new Error(`rollback ${role} exact Cloudflare version identity is unavailable or invalid`);
    }
    string(component.deployment.deployment_id, `rollback ${role} deployment_id`);
    string(component.deployment.captured_by, `rollback ${role} captured_by`);
  }
  for (const role of requiredRoles) if (!roles.has(role)) throw new Error(`rollback component is missing: ${role}`);
  if (!Array.isArray(payload.artifacts) || payload.artifacts.length === 0) throw new Error("rollback workflow/config artifacts are missing");
  const artifactRoles = new Set();
  for (const artifact of payload.artifacts) {
    validateGitArtifact(artifact, repositoryRoot, "rollback artifact");
    if (artifactRoles.has(artifact.role)) throw new Error(`rollback artifact role is duplicated: ${artifact.role}`);
    artifactRoles.add(artifact.role);
  }
  for (const required of [
    "observations_deploy_workflow",
    "station_deploy_workflow",
    "cache_deploy_workflow",
    "observations_worker_config",
    "station_worker_config",
    "cache_worker_config",
    "cache_binding_resolver",
  ]) {
    if (!artifactRoles.has(required)) throw new Error(`rollback artifact is missing: ${required}`);
  }
  if (!Array.isArray(payload.restore_steps) || payload.restore_steps.length === 0) throw new Error("rollback restore_steps are missing");
  const restoreRoles = new Set();
  payload.restore_steps.forEach((step, index) => {
    exactKeys(step, ["order", "role", "kind", "description", "command_or_workflow"], `rollback restore step ${index + 1}`);
    if (step.order !== index + 1) throw new Error("rollback restore step order is not exact and contiguous");
    const role = string(step.role, `rollback restore step ${index + 1} role`);
    if (restoreRoles.has(role)) throw new Error(`rollback restore step role is duplicated: ${role}`);
    restoreRoles.add(role);
    if (!new Set(["command", "github_workflow"]).has(step.kind)) throw new Error(`rollback restore step ${index + 1} kind is invalid`);
    string(step.description, `rollback restore step ${index + 1} description`);
    string(step.command_or_workflow, `rollback restore step ${index + 1} command_or_workflow`);
  });
  for (const required of [
    "restore_observations_worker",
    "restore_station_worker",
    "restore_v2_index_authority",
    "restore_cache_worker_v2_binding",
  ]) {
    if (!restoreRoles.has(required)) throw new Error(`rollback restore step is missing: ${required}`);
  }
}

export function validateIndexV3OperatorEvidence({ evidence, repositoryRoot, planReport = null }) {
  exactKeys(evidence, ["schema_version", "kind", "payload", "payload_sha256"], "operator evidence envelope");
  if (evidence.schema_version !== 1 || !KINDS.has(evidence.kind)) throw new Error("operator evidence schema/kind is invalid");
  plain(evidence.payload, "operator evidence payload");
  assertNoSecrets(evidence.payload);
  const expectedSha = sha256(stableJson(evidence.payload));
  if (requireSha(evidence.payload_sha256, "operator evidence payload_sha256") !== expectedSha) {
    throw new Error("operator evidence payload SHA-256 is invalid");
  }
  const options = { repositoryRoot: path.resolve(repositoryRoot), planReport };
  if (evidence.kind === "uk_aq_index_v3_writer_freeze_evidence") {
    if (!planReport) throw new Error("writer-freeze validation requires the migration plan report");
    validateWriterFreezePayload(evidence.payload, options);
  } else {
    validateRollbackPayload(evidence.payload, options);
  }
  return Object.freeze({
    ok: true,
    kind: evidence.kind,
    payload_sha256: evidence.payload_sha256,
    environment: evidence.payload.environment,
    repository: evidence.payload.repository,
    branch: evidence.payload.branch,
  });
}

function parseArgs(argv) {
  const args = { mode: "", payload: "", evidence: "", out: "", planReport: "", repositoryRoot: "." };
  if (argv.length) args.mode = argv[0];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--payload") args.payload = String(argv[++index] || "");
    else if (flag === "--evidence") args.evidence = String(argv[++index] || "");
    else if (flag === "--out") args.out = String(argv[++index] || "");
    else if (flag === "--plan-report") args.planReport = String(argv[++index] || "");
    else if (flag === "--repository-root") args.repositoryRoot = String(argv[++index] || "");
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!new Set(["seal", "validate"]).has(args.mode)) {
    throw new Error("Usage: index_v3_operator_evidence.mjs seal --payload PAYLOAD.json --out EVIDENCE.json [--plan-report PLAN.json] | validate --evidence EVIDENCE.json [--plan-report PLAN.json]");
  }
  const planReport = args.planReport ? readJson(args.planReport, "migration plan report") : null;
  if (args.mode === "seal") {
    if (!args.payload || !args.out) throw new Error("seal requires --payload and --out");
    const payloadDocument = readJson(args.payload, "operator evidence payload");
    exactKeys(payloadDocument, ["kind", "payload"], "operator evidence payload document");
    if (!KINDS.has(payloadDocument.kind)) throw new Error("operator evidence payload kind is unsupported");
    const envelope = {
      schema_version: 1,
      kind: payloadDocument.kind,
      payload: payloadDocument.payload,
      payload_sha256: sha256(stableJson(payloadDocument.payload)),
    };
    validateIndexV3OperatorEvidence({ evidence: envelope, repositoryRoot: args.repositoryRoot, planReport });
    fs.writeFileSync(path.resolve(args.out), stableJson(envelope), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, out: path.resolve(args.out), payload_sha256: envelope.payload_sha256 })}\n`);
    return;
  }
  if (!args.evidence) throw new Error("validate requires --evidence");
  const evidence = readJson(args.evidence, "operator evidence");
  process.stdout.write(`${JSON.stringify(validateIndexV3OperatorEvidence({ evidence, repositoryRoot: args.repositoryRoot, planReport }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
