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

function validateCacheIdentity(identity, repositoryRoot, label, expectedService, expectedVersionTrigger, expectedDeploymentTrigger) {
  exactKeys(identity, [
    "workflow_run_id", "git_commit_sha", "worker_name", "version_id", "version_number",
    "version_created_on", "version_source", "version_triggered_by", "actor_identity_sha256",
    "script_etag", "script_handlers", "script_last_deployed_from", "script_runtime",
    "binding_descriptors", "deployment_id", "deployment_created_on", "deployment_source",
    "deployment_strategy", "deployment_triggered_by", "deployment_percentage",
    "station_history_service",
  ], label);
  if (!/^[1-9][0-9]*$/.test(string(identity.workflow_run_id, `${label} workflow_run_id`))) {
    throw new Error(`${label} workflow_run_id is invalid`);
  }
  const commit = requireSha(identity.git_commit_sha, `${label} git_commit_sha`, GIT_SHA);
  if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repositoryRoot }).status !== 0) {
    throw new Error(`${label} git commit is unavailable`);
  }
  const worker = string(identity.worker_name, `${label} worker_name`);
  if (!WORKER_NAME.test(worker) || worker.endsWith("-v3-candidate") || worker.length > 63) {
    throw new Error(`${label} stable Worker name is invalid`);
  }
  if (!UUID.test(string(identity.version_id, `${label} version_id`))) throw new Error(`${label} version_id is invalid`);
  if (!Number.isInteger(identity.version_number) || identity.version_number < 1) throw new Error(`${label} version_number is invalid`);
  timestamp(identity.version_created_on, `${label} version_created_on`);
  if (identity.version_source !== "wrangler" || identity.version_triggered_by !== expectedVersionTrigger) {
    throw new Error(`${label} version source/trigger is invalid`);
  }
  requireSha(identity.actor_identity_sha256, `${label} actor_identity_sha256`);
  requireSha(identity.script_etag, `${label} script_etag`);
  if (!Array.isArray(identity.script_handlers) || identity.script_handlers.length === 0
    || identity.script_handlers.some((handler) => typeof handler !== "string" || !handler)) {
    throw new Error(`${label} script_handlers are invalid`);
  }
  string(identity.script_last_deployed_from, `${label} script_last_deployed_from`);
  exactKeys(identity.script_runtime, ["compatibility_date", "compatibility_flags", "usage_model"], `${label} script_runtime`);
  string(identity.script_runtime.compatibility_date, `${label} compatibility_date`);
  string(identity.script_runtime.usage_model, `${label} usage_model`);
  if (!Array.isArray(identity.script_runtime.compatibility_flags)
    || identity.script_runtime.compatibility_flags.some((flag) => typeof flag !== "string" || !flag)) {
    throw new Error(`${label} compatibility_flags are invalid`);
  }
  if (!Array.isArray(identity.binding_descriptors) || identity.binding_descriptors.length === 0) {
    throw new Error(`${label} binding_descriptors are missing`);
  }
  let serviceBindings = 0;
  for (const binding of identity.binding_descriptors) {
    const type = string(binding?.type, `${label} binding type`);
    if (type === "secret_text") exactKeys(binding, ["name", "type"], `${label} secret-text binding`);
    else if (type === "service") {
      exactKeys(binding, ["name", "type", "service", "environment"], `${label} service binding`);
      if (binding.name === "STATION_HISTORY" && binding.service === expectedService) serviceBindings += 1;
    } else throw new Error(`${label} binding type is unsupported`);
    string(binding.name, `${label} binding name`);
  }
  if (serviceBindings !== 1 || identity.station_history_service !== expectedService) {
    throw new Error(`${label} STATION_HISTORY binding is invalid`);
  }
  if (!UUID.test(string(identity.deployment_id, `${label} deployment_id`))) throw new Error(`${label} deployment_id is invalid`);
  timestamp(identity.deployment_created_on, `${label} deployment_created_on`);
  if (identity.deployment_source !== "wrangler" || identity.deployment_strategy !== "percentage"
    || identity.deployment_triggered_by !== expectedDeploymentTrigger || identity.deployment_percentage !== 100) {
    throw new Error(`${label} deployment source/strategy/trigger/percentage is invalid`);
  }
  return identity;
}

function validateCacheProvenance(provenance, repositoryRoot) {
  exactKeys(provenance, [
    "accepted_v2_cache_baseline", "pre_cutover_v2_cache_runtime",
    "explicit_v3_cache_cutover", "transition_proof",
  ], "cache provenance");
  const proof = plain(provenance.transition_proof, "cache transition_proof");
  exactKeys(proof, [
    "kind", "baseline_differs_from_pre_cutover_runtime", "pre_cutover_is_immediate_predecessor",
    "script_identity_match", "script_runtime_match", "binding_descriptors_match",
    "actor_identity_match", "version_numbers_consecutive", "workflow_correlation", "explanation",
  ], "cache transition_proof");
  const refresh = proof.kind === "cutover_workflow_secret_refresh";
  if (!refresh && proof.kind !== "accepted_v2_baseline_immediate_predecessor") {
    throw new Error("cache transition_proof kind is invalid");
  }
  if (proof.baseline_differs_from_pre_cutover_runtime !== refresh
    || proof.pre_cutover_is_immediate_predecessor !== true
    || proof.script_identity_match !== true
    || proof.script_runtime_match !== true
    || proof.binding_descriptors_match !== true
    || proof.actor_identity_match !== true
    || proof.version_numbers_consecutive !== true) {
    throw new Error("cache transition_proof assertions are invalid");
  }
  string(proof.explanation, "cache transition_proof explanation");
  const stableService = string(provenance.accepted_v2_cache_baseline?.station_history_service, "accepted v2 cache service");
  const baseline = validateCacheIdentity(
    provenance.accepted_v2_cache_baseline, repositoryRoot, "accepted v2 cache baseline", stableService, "version_upload", "deployment",
  );
  const runtime = validateCacheIdentity(
    provenance.pre_cutover_v2_cache_runtime, repositoryRoot, "pre-cutover v2 cache runtime", stableService,
    refresh ? "secret" : "version_upload", refresh ? "secret" : "deployment",
  );
  const cutover = validateCacheIdentity(
    provenance.explicit_v3_cache_cutover, repositoryRoot, "explicit v3 cache cut-over", `${stableService}-v3-candidate`, "version_upload", "deployment",
  );
  if (baseline.worker_name !== runtime.worker_name || runtime.worker_name !== cutover.worker_name) {
    throw new Error("cache provenance Worker names differ");
  }
  const baselineTime = Date.parse(baseline.deployment_created_on);
  const runtimeTime = Date.parse(runtime.deployment_created_on);
  const cutoverTime = Date.parse(cutover.deployment_created_on);
  if (baselineTime > runtimeTime || runtimeTime >= cutoverTime) throw new Error("cache provenance chronology is invalid");
  if (baseline.script_etag !== runtime.script_etag
    || stableJson(baseline.script_handlers) !== stableJson(runtime.script_handlers)
    || baseline.script_last_deployed_from !== runtime.script_last_deployed_from
    || stableJson(baseline.script_runtime) !== stableJson(runtime.script_runtime)
    || stableJson(baseline.binding_descriptors) !== stableJson(runtime.binding_descriptors)
    || baseline.actor_identity_sha256 !== runtime.actor_identity_sha256
    || runtime.actor_identity_sha256 !== cutover.actor_identity_sha256) {
    throw new Error("cache provenance equivalence evidence is contradictory");
  }
  if (refresh) {
    if (baseline.version_id === runtime.version_id || baseline.deployment_id === runtime.deployment_id
      || runtime.workflow_run_id !== cutover.workflow_run_id
      || runtime.version_number !== baseline.version_number + 1
      || cutover.version_number !== runtime.version_number + 1) {
      throw new Error("cache secret-refresh identity sequence is invalid");
    }
    exactKeys(proof.workflow_correlation, ["refresh_step", "deploy_step"], "cache workflow_correlation");
    const validateStep = (step, label, expectedName) => {
      exactKeys(step, ["name", "started_at", "completed_at"], label);
      if (step.name !== expectedName) throw new Error(`${label} name is invalid`);
      const started = Date.parse(timestamp(step.started_at, `${label} started_at`));
      const completed = Date.parse(timestamp(step.completed_at, `${label} completed_at`));
      if (started > completed) throw new Error(`${label} chronology is invalid`);
      return { started, completed };
    };
    const refreshStep = validateStep(proof.workflow_correlation.refresh_step, "cache refresh step", "Apply Worker secrets to existing cache Worker");
    const deployStep = validateStep(proof.workflow_correlation.deploy_step, "cache deploy step", "Deploy Worker");
    if (runtimeTime < refreshStep.started || runtimeTime > refreshStep.completed
      || cutoverTime < deployStep.started || cutoverTime > deployStep.completed
      || refreshStep.completed > deployStep.started) {
      throw new Error("cache workflow/deployment timestamp correlation is invalid");
    }
  } else if (proof.workflow_correlation !== null
    || baseline.version_id !== runtime.version_id || baseline.deployment_id !== runtime.deployment_id
    || baseline.workflow_run_id !== runtime.workflow_run_id) {
    throw new Error("direct v2 cache baseline/runtime identity is invalid");
  }
  return provenance;
}

function validateRollbackPayload(payload, { repositoryRoot }) {
  exactKeys(payload, [
    "environment", "repository", "branch", "repository_head", "recorded_at_utc",
    "history_version", "index_authority_generation", "integrity_version", "components",
    "cache_provenance", "artifacts", "restore_steps",
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
  const cacheProvenance = validateCacheProvenance(payload.cache_provenance, repositoryRoot);
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
  const cacheComponent = payload.components.find(({ role }) => role === "cache_worker");
  const exactCacheRuntime = cacheProvenance.pre_cutover_v2_cache_runtime;
  if (cacheComponent.worker_name !== exactCacheRuntime.worker_name
    || cacheComponent.deployment.version_id !== exactCacheRuntime.version_id
    || cacheComponent.deployment.deployment_id !== exactCacheRuntime.deployment_id
    || cacheComponent.git_commit_sha !== cacheProvenance.accepted_v2_cache_baseline.git_commit_sha) {
    throw new Error("rollback cache component does not match the exact pre-cutover v2 cache runtime and accepted baseline");
  }
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
    "cache_cutover_deploy_workflow",
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
  const cacheRestore = payload.restore_steps.find(({ role }) => role === "restore_cache_worker_v2_binding");
  const expectedCacheCommand = `npx wrangler versions deploy ${exactCacheRuntime.version_id}@100% --name ${exactCacheRuntime.worker_name} -y`;
  if (cacheRestore.command_or_workflow !== expectedCacheCommand) {
    throw new Error("rollback cache restore command does not pin the exact pre-cutover v2 cache runtime");
  }
  if (payload.restore_steps.some(({ command_or_workflow }) => command_or_workflow.includes("-v3-candidate"))) {
    throw new Error("rollback restore command references a v3 candidate Worker");
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
