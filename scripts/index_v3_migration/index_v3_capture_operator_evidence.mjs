#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40}$/;
const WORKER_NAME = /^(?!-)(?!.*-$)[a-z0-9-]{1,63}$/;
const RESUME_BOUNDARY = "accepted_v3_cutover_or_completed_v2_rollback";
const SEALER = fileURLToPath(new URL("./index_v3_operator_evidence.mjs", import.meta.url));
const WORKFLOWS = Object.freeze({
  observations: ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml",
  station: ".github/workflows/uk_aq_station_history_deploy.yml",
  cache: ".github/workflows/uk_aq_cache_proxy_deploy.yml",
});

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(`${label} is unreadable or invalid JSON: ${filePath}`, { cause: error });
  }
}

function run(command, args, { cwd, encoding = "utf8", maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding, maxBuffer });
  if (result.status !== 0) {
    const detail = encoding === null ? "" : String(result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function git(repositoryRoot, args, options = {}) {
  return run("git", args, { cwd: repositoryRoot, ...options });
}

export function assertCleanWorkingTree(repositoryRoot) {
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.trim()) throw new Error("Operator evidence capture requires a clean Git working tree");
}

function repositoryState(repositoryRoot) {
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const branch = git(repositoryRoot, ["branch", "--show-current"]).trim();
  if (!GIT_SHA.test(head) || !branch) throw new Error("Repository HEAD or branch is unavailable");
  return { head, branch };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
}

const stableJsonValue = (value) => JSON.stringify(stableObject(value));

export function gitBlobIdentity(repositoryRoot, role, relativePath, commit) {
  if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`Unsafe Git artifact path: ${relativePath}`);
  }
  if (!GIT_SHA.test(commit)) throw new Error(`Invalid Git commit for ${role}`);
  const body = git(repositoryRoot, ["cat-file", "blob", `${commit}:${relativePath}`], { encoding: null });
  return { role, path: relativePath, git_commit_sha: commit, sha256: sha256(body) };
}

export function buildWriterFreezePayload({
  planReport,
  repositoryRoot,
  environment,
  repository,
  branch,
  head,
  operator,
  confirmed,
  confirmedAt = new Date().toISOString(),
}) {
  if (confirmed !== true) throw new Error("writer-freeze requires explicit --confirm-frozen");
  requiredString(operator, "operator");
  const result = planReport?.result;
  const plan = result?.writer_freeze_plan;
  if (!result || !plan || !Array.isArray(plan.entries) || plan.entries.length === 0) {
    throw new Error("Migration plan has no result.writer_freeze_plan.entries");
  }
  const planEnvironment = typeof result.environment === "string"
    ? result.environment
    : result.environment?.environment;
  if (requiredString(planEnvironment, "migration plan environment").toUpperCase() !== environment) {
    throw new Error("Migration plan environment does not match the corroborated capture environment");
  }
  const ids = new Set();
  const entries = plan.entries.map((definition) => {
    const id = requiredString(definition?.id, "writer-freeze plan entry id");
    if (ids.has(id)) throw new Error(`Migration plan duplicates writer-freeze class: ${id}`);
    ids.add(id);
    if (!Array.isArray(definition.evidence_files) || definition.evidence_files.length === 0) {
      throw new Error(`Migration plan has no evidence files for ${id}`);
    }
    if (new Set(definition.evidence_files).size !== definition.evidence_files.length) {
      throw new Error(`Migration plan duplicates an evidence file for ${id}`);
    }
    return {
      id,
      control: definition.kind === "scheduled_workflow" ? "scheduler_and_workflow" : "manual_operator_freeze",
      frozen: true,
      operator_assertion: `Operator confirms this mutation entry point will remain frozen and will not be started before ${RESUME_BOUNDARY}.`,
      entrypoints: definition.evidence_files.map((file) =>
        gitBlobIdentity(repositoryRoot, "mutation_entrypoint", requiredString(file, `${id} evidence file`), head)),
    };
  });
  return {
    environment,
    repository,
    branch,
    repository_head: head,
    migration_run_id: requiredString(result.migration_run_id, "migration plan run id"),
    plan_sha256: requiredString(result.plan_sha256, "migration plan SHA-256"),
    confirmed_at_utc: confirmedAt,
    operator: operator.trim(),
    resume_boundary: RESUME_BOUNDARY,
    entries,
  };
}

export function parseWorkflowVersionId(log, label) {
  const ids = new Set();
  const expression = /\b(?:Current\s+Version\s+ID|Version\s+ID)\s*:\s*([0-9a-f-]{36})\b/gi;
  for (const match of String(log || "").matchAll(expression)) {
    if (UUID.test(match[1])) ids.add(match[1].toLowerCase());
  }
  if (ids.size !== 1) throw new Error(`${label} log does not contain exactly one explicit Cloudflare version UUID`);
  return [...ids][0];
}

function assertStableWorkerName(name, label) {
  const worker = requiredString(name, label);
  if (!WORKER_NAME.test(worker) || worker.endsWith("-v3-candidate")) {
    throw new Error(`${label} is not a stable Worker identity`);
  }
  return worker;
}

function workflowPath(rawPath) {
  return String(rawPath || "").split("@")[0];
}

function validateRun(runRecord, expectedPath, defaultBranch, label) {
  if (!runRecord || String(runRecord.status) !== "completed" || String(runRecord.conclusion) !== "success") {
    throw new Error(`${label} GitHub workflow run is not completed successfully`);
  }
  if (workflowPath(runRecord.path) !== expectedPath) throw new Error(`${label} used an unexpected GitHub workflow`);
  if (runRecord.head_branch !== defaultBranch) throw new Error(`${label} did not run from the default branch`);
  if (!GIT_SHA.test(String(runRecord.head_sha || ""))) throw new Error(`${label} Git commit is unavailable`);
  return runRecord;
}

export function selectDeployment(deployments, versionId, label) {
  if (!UUID.test(String(versionId || ""))) throw new Error(`${label} exact Cloudflare version UUID is invalid`);
  const matches = (Array.isArray(deployments) ? deployments : []).filter((deployment) => {
    const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
    return UUID.test(String(deployment?.id || ""))
      && versions.length === 1
      && versions[0].version_id === versionId
      && Number(versions[0].percentage) === 100;
  });
  if (matches.length !== 1) throw new Error(`${label} exact Cloudflare deployment identity is unavailable or ambiguous`);
  return matches[0];
}

function deploymentCreatedOn(deployment, label) {
  const raw = requiredString(deployment?.created_on, `${label} created_on`);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} created_on is invalid`);
  return timestamp;
}

function isNormalFullDeployment(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  return UUID.test(String(deployment?.id || ""))
    && versions.length === 1
    && UUID.test(String(versions[0]?.version_id || ""))
    && Number(versions[0]?.percentage) === 100;
}

export function assertStableDeploymentAtCutover({
  deployments,
  selectedDeployment,
  cutoverDeployment,
  label,
}) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(`${label} Cloudflare deployment history is missing`);
  }
  if (!isNormalFullDeployment(selectedDeployment)) {
    throw new Error(`${label} selected deployment is not a normal 100% deployment`);
  }
  const cutoverTime = deploymentCreatedOn(cutoverDeployment, "v3 cache cut-over deployment");
  const selectedTime = deploymentCreatedOn(selectedDeployment, `${label} selected deployment`);
  if (selectedTime > cutoverTime) throw new Error(`${label} selected deployment is after the v3 cache cut-over`);

  const identities = new Set();
  let selectedPresent = false;
  for (const deployment of deployments) {
    const createdOn = deploymentCreatedOn(deployment, `${label} deployment ${deployment?.id}`);
    const identity = String(deployment?.id || "");
    if (UUID.test(identity)) {
      if (identities.has(identity)) throw new Error(`${label} Cloudflare deployment history duplicates an identity`);
      identities.add(identity);
    }
    if (createdOn < selectedTime || createdOn > cutoverTime) continue;
    if (!UUID.test(identity)) throw new Error(`${label} deployment identity is invalid in the relevant cut-over interval`);
    if (identity === selectedDeployment.id) {
      if (createdOn !== selectedTime
        || !isNormalFullDeployment(deployment)
        || deployment.versions[0].version_id !== selectedDeployment.versions[0].version_id) {
        throw new Error(`${label} selected deployment does not match its Cloudflare history record`);
      }
      selectedPresent = true;
      continue;
    }
    if (createdOn === selectedTime) {
      throw new Error(`${label} deployment chronology is ambiguous at the selected deployment time`);
    }
    if (createdOn === cutoverTime) {
      throw new Error(`${label} deployment chronology is ambiguous at the v3 cache cut-over`);
    }
    throw new Error(`${label} selected deployment was superseded before the v3 cache cut-over by another deployment`);
  }
  if (!selectedPresent) throw new Error(`${label} selected deployment is missing from Cloudflare deployment history`);
}

function assertVersionDetail(detail, versionId, label) {
  if (!detail || detail.id !== versionId) throw new Error(`${label} Cloudflare version detail does not match the workflow UUID`);
}

function serviceBinding(detail, bindingName) {
  return (detail?.resources?.bindings || []).filter((binding) =>
    binding?.type === "service" && binding?.name === bindingName);
}

function cacheBindingDescriptors(detail, label) {
  const bindings = detail?.resources?.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) throw new Error(`${label} Cloudflare bindings are missing`);
  return bindings.map((binding) => {
    const name = requiredString(binding?.name, `${label} binding name`);
    const type = requiredString(binding?.type, `${label} binding type`);
    if (type === "secret_text") return { name, type };
    if (type === "service") {
      return {
        name,
        type,
        service: requiredString(binding?.service, `${label} service binding target`),
        environment: requiredString(binding?.environment || "production", `${label} service binding environment`),
      };
    }
    throw new Error(`${label} has an unsupported binding type: ${type}`);
  }).sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
}

function cacheVersionIdentity(detail, expectedVersionId, label) {
  assertVersionDetail(detail, expectedVersionId, label);
  const number = Number(detail?.number);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} Cloudflare version number is invalid`);
  const metadata = detail?.metadata;
  const script = detail?.resources?.script;
  const runtime = detail?.resources?.script_runtime;
  const handlers = Array.isArray(script?.handlers) ? [...script.handlers].sort() : [];
  if (handlers.length === 0 || handlers.some((handler) => typeof handler !== "string" || !handler)) {
    throw new Error(`${label} Cloudflare script handlers are invalid`);
  }
  const actorId = requiredString(metadata?.author_id, `${label} Cloudflare author_id`);
  const actorEmail = requiredString(metadata?.author_email, `${label} Cloudflare author_email`);
  const versionCreatedOn = requiredString(metadata?.created_on, `${label} Cloudflare version created_on`);
  deploymentCreatedOn({ created_on: versionCreatedOn }, `${label} version`);
  return {
    version_id: expectedVersionId,
    version_number: number,
    version_created_on: versionCreatedOn,
    version_source: requiredString(metadata?.source, `${label} Cloudflare version source`),
    version_triggered_by: requiredString(detail?.annotations?.["workers/triggered_by"], `${label} Cloudflare version trigger`),
    actor_identity_sha256: sha256(`${actorId}\n${actorEmail}`),
    script_etag: requiredString(script?.etag, `${label} Cloudflare script etag`),
    script_handlers: handlers,
    script_last_deployed_from: requiredString(script?.last_deployed_from, `${label} Cloudflare script deployment source`),
    script_runtime: {
      compatibility_date: requiredString(runtime?.compatibility_date, `${label} compatibility_date`),
      compatibility_flags: Array.isArray(runtime?.compatibility_flags) ? [...runtime.compatibility_flags].sort() : [],
      usage_model: requiredString(runtime?.usage_model, `${label} usage_model`),
    },
    binding_descriptors: cacheBindingDescriptors(detail, label),
  };
}

function orderedDeploymentHistory(deployments, label) {
  if (!Array.isArray(deployments) || deployments.length === 0) throw new Error(`${label} deployment history is missing`);
  const identities = new Set();
  const ordered = deployments.map((deployment) => {
    const id = requiredString(deployment?.id, `${label} deployment id`);
    if (!UUID.test(id)) throw new Error(`${label} deployment id is invalid`);
    if (identities.has(id)) throw new Error(`${label} deployment history duplicates an identity`);
    identities.add(id);
    return { deployment, createdOn: deploymentCreatedOn(deployment, `${label} deployment ${id}`) };
  }).sort((left, right) => right.createdOn - left.createdOn);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].createdOn === ordered[index].createdOn) {
      throw new Error(`${label} deployment chronology is ambiguous`);
    }
  }
  return ordered;
}

function immediateDeploymentBefore(deployments, selectedDeployment, label) {
  const ordered = orderedDeploymentHistory(deployments, label);
  const selectedIndex = ordered.findIndex(({ deployment }) => deployment.id === selectedDeployment.id);
  if (selectedIndex < 0 || selectedIndex + 1 >= ordered.length) {
    throw new Error(`${label} has no unambiguous deployment immediately before the selected deployment`);
  }
  return ordered[selectedIndex + 1].deployment;
}

function assertNormalDeploymentMetadata(deployment, expectedTrigger, label) {
  if (!isNormalFullDeployment(deployment)) throw new Error(`${label} is not a normal single-version 100% deployment`);
  if (deployment?.source !== "wrangler" || deployment?.strategy !== "percentage") {
    throw new Error(`${label} Cloudflare source/strategy is not the accepted normal deployment form`);
  }
  if (deployment?.annotations?.["workers/triggered_by"] !== expectedTrigger) {
    throw new Error(`${label} Cloudflare deployment trigger is not ${expectedTrigger}`);
  }
}

function successfulCutoverSteps(runRecord, preCutoverDeployment, v3Deployment) {
  const jobs = Array.isArray(runRecord?.jobs) ? runRecord.jobs : [];
  const steps = jobs.flatMap((job) => Array.isArray(job?.steps) ? job.steps : []);
  const findOne = (name) => {
    const matches = steps.filter((step) => step?.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`v3 cache cut-over run does not contain one successful ${name} step`);
    }
    const startedOn = deploymentCreatedOn({ created_on: matches[0].started_at }, `${name} step start`);
    const completedOn = deploymentCreatedOn({ created_on: matches[0].completed_at }, `${name} step completion`);
    if (startedOn > completedOn) throw new Error(`${name} step chronology is invalid`);
    return { step: matches[0], startedOn, completedOn };
  };
  const refresh = findOne("Apply Worker secrets to existing cache Worker");
  const deploy = findOne("Deploy Worker");
  if (!Number.isInteger(refresh.step.number) || deploy.step.number !== refresh.step.number + 1 || refresh.completedOn > deploy.startedOn) {
    throw new Error("v3 cache cut-over refresh/deploy step ordering is invalid");
  }
  const refreshDeploymentTime = deploymentCreatedOn(preCutoverDeployment, "pre-cutover cache runtime deployment");
  const v3DeploymentTime = deploymentCreatedOn(v3Deployment, "v3 cache cut-over deployment");
  if (refreshDeploymentTime < refresh.startedOn || refreshDeploymentTime > refresh.completedOn) {
    throw new Error("pre-cutover cache runtime deployment does not fall within the successful refresh step");
  }
  if (v3DeploymentTime < deploy.startedOn || v3DeploymentTime > deploy.completedOn) {
    throw new Error("explicit v3 cache deployment does not fall within the successful deploy step");
  }
  return {
    refresh_step: { name: refresh.step.name, started_at: refresh.step.started_at, completed_at: refresh.step.completed_at },
    deploy_step: { name: deploy.step.name, started_at: deploy.step.started_at, completed_at: deploy.step.completed_at },
  };
}

export function assertHistoricalCacheSelection({
  deployments,
  v2Deployment,
  v3Deployment,
  v2VersionDetail,
  preCutoverVersionDetail,
  v3VersionDetail,
  stableStationWorker,
  cacheWorker,
  cacheV2Run,
  cacheV3Run,
}) {
  if (v2Deployment.id === v3Deployment.id) throw new Error("v2 and v3 cache deployment identities are identical");
  const preCutoverDeployment = immediateDeploymentBefore(deployments, v3Deployment, "cache");
  const v2Time = deploymentCreatedOn(v2Deployment, "accepted v2 cache baseline deployment");
  const preCutoverTime = deploymentCreatedOn(preCutoverDeployment, "pre-cutover v2 cache runtime deployment");
  const v3Time = deploymentCreatedOn(v3Deployment, "explicit v3 cache cut-over deployment");
  if (v2Time > preCutoverTime || preCutoverTime >= v3Time) {
    throw new Error("Accepted v2 baseline, pre-cutover runtime, and v3 cache deployment chronology is invalid");
  }
  assertNormalDeploymentMetadata(v2Deployment, "deployment", "Accepted v2 cache baseline deployment");
  assertNormalDeploymentMetadata(v3Deployment, "deployment", "Explicit v3 cache cut-over deployment");

  const baselineVersion = cacheVersionIdentity(v2VersionDetail, v2Deployment.versions[0].version_id, "accepted v2 cache baseline");
  const preCutoverVersion = cacheVersionIdentity(preCutoverVersionDetail, preCutoverDeployment.versions[0].version_id, "pre-cutover v2 cache runtime");
  const cutoverVersion = cacheVersionIdentity(v3VersionDetail, v3Deployment.versions[0].version_id, "explicit v3 cache cut-over");
  const v2Bindings = serviceBinding(v2VersionDetail, "STATION_HISTORY");
  const preCutoverBindings = serviceBinding(preCutoverVersionDetail, "STATION_HISTORY");
  const v3Bindings = serviceBinding(v3VersionDetail, "STATION_HISTORY");
  if (v2Bindings.length !== 1 || v2Bindings[0].service !== stableStationWorker) {
    throw new Error("Historical v2 cache version is not bound to the stable station-history Worker");
  }
  if (preCutoverBindings.length !== 1 || preCutoverBindings[0].service !== stableStationWorker) {
    throw new Error("Pre-cutover v2 cache runtime is not bound to the stable station-history Worker");
  }
  if (v3Bindings.length !== 1 || v3Bindings[0].service !== `${stableStationWorker}-v3-candidate`) {
    throw new Error("Explicit v3 cache cut-over version is not bound to the station-history candidate");
  }

  let kind = "accepted_v2_baseline_immediate_predecessor";
  let workflowCorrelation = null;
  const differsFromBaseline = preCutoverDeployment.id !== v2Deployment.id;
  if (differsFromBaseline) {
    kind = "cutover_workflow_secret_refresh";
    assertNormalDeploymentMetadata(preCutoverDeployment, "secret", "Pre-cutover v2 cache runtime deployment");
    if (baselineVersion.version_source !== "wrangler" || baselineVersion.version_triggered_by !== "version_upload"
      || preCutoverVersion.version_source !== "wrangler" || preCutoverVersion.version_triggered_by !== "secret"
      || cutoverVersion.version_source !== "wrangler" || cutoverVersion.version_triggered_by !== "version_upload") {
      throw new Error("Cache version source/trigger chronology does not prove a Wrangler secret refresh between deployments");
    }
    if (preCutoverVersion.version_number !== baselineVersion.version_number + 1
      || cutoverVersion.version_number !== preCutoverVersion.version_number + 1) {
      throw new Error("Cache Cloudflare version numbers are not consecutive across the secret refresh and cut-over");
    }
    if (baselineVersion.script_etag !== preCutoverVersion.script_etag
      || stableJsonValue(baselineVersion.script_handlers) !== stableJsonValue(preCutoverVersion.script_handlers)
      || baselineVersion.script_last_deployed_from !== preCutoverVersion.script_last_deployed_from
      || stableJsonValue(baselineVersion.script_runtime) !== stableJsonValue(preCutoverVersion.script_runtime)) {
      throw new Error("Pre-cutover cache runtime does not retain the accepted v2 baseline code/runtime identity");
    }
    if (stableJsonValue(baselineVersion.binding_descriptors) !== stableJsonValue(preCutoverVersion.binding_descriptors)) {
      throw new Error("Pre-cutover cache runtime does not retain the accepted v2 non-value binding descriptors");
    }
    if (baselineVersion.actor_identity_sha256 !== preCutoverVersion.actor_identity_sha256
      || preCutoverVersion.actor_identity_sha256 !== cutoverVersion.actor_identity_sha256) {
      throw new Error("Cache version actor identity is inconsistent across baseline, refresh, and cut-over");
    }
    workflowCorrelation = successfulCutoverSteps(cacheV3Run, preCutoverDeployment, v3Deployment);
  } else if (preCutoverVersion.version_id !== baselineVersion.version_id) {
    throw new Error("Immediate pre-cutover cache deployment does not match the accepted v2 baseline version");
  }

  const identity = (runRecord, version, deployment, stationHistoryService) => ({
    workflow_run_id: String(runRecord.id),
    git_commit_sha: runRecord.head_sha,
    worker_name: cacheWorker,
    ...version,
    deployment_id: deployment.id,
    deployment_created_on: deployment.created_on,
    deployment_source: deployment.source,
    deployment_strategy: deployment.strategy,
    deployment_triggered_by: deployment.annotations["workers/triggered_by"],
    deployment_percentage: Number(deployment.versions[0].percentage),
    station_history_service: stationHistoryService,
  });
  return {
    accepted_v2_cache_baseline: identity(cacheV2Run, baselineVersion, v2Deployment, stableStationWorker),
    pre_cutover_v2_cache_runtime: identity(
      differsFromBaseline ? cacheV3Run : cacheV2Run,
      preCutoverVersion,
      preCutoverDeployment,
      stableStationWorker,
    ),
    explicit_v3_cache_cutover: identity(cacheV3Run, cutoverVersion, v3Deployment, `${stableStationWorker}-v3-candidate`),
    transition_proof: {
      kind,
      baseline_differs_from_pre_cutover_runtime: differsFromBaseline,
      pre_cutover_is_immediate_predecessor: true,
      script_identity_match: baselineVersion.script_etag === preCutoverVersion.script_etag,
      script_runtime_match: stableJsonValue(baselineVersion.script_runtime) === stableJsonValue(preCutoverVersion.script_runtime),
      binding_descriptors_match: stableJsonValue(baselineVersion.binding_descriptors) === stableJsonValue(preCutoverVersion.binding_descriptors),
      actor_identity_match: baselineVersion.actor_identity_sha256 === preCutoverVersion.actor_identity_sha256
        && preCutoverVersion.actor_identity_sha256 === cutoverVersion.actor_identity_sha256,
      version_numbers_consecutive: differsFromBaseline
        ? preCutoverVersion.version_number === baselineVersion.version_number + 1
          && cutoverVersion.version_number === preCutoverVersion.version_number + 1
        : true,
      workflow_correlation: workflowCorrelation,
      explanation: differsFromBaseline
        ? "The exact pre-cutover v2-equivalent cache runtime was created and deployed by the successful secret-refresh step in the explicit v3 cut-over workflow; Cloudflare code/runtime and non-value binding identities remain equal to the accepted v2 baseline."
        : "The accepted v2 cache baseline deployment is itself the immediate pre-cutover runtime.",
    },
  };
}

const component = (role, workerName, commit, versionId, deploymentId, runId, capturedBy = "") => ({
  role,
  worker_name: workerName,
  git_commit_sha: commit,
  deployment: {
    version_id: versionId,
    deployment_id: deploymentId,
    captured_by: capturedBy || `GitHub Actions run ${runId} version UUID corroborated by the read-only Cloudflare Workers deployments and version-detail APIs`,
  },
});

export function buildRollbackPayload({
  repositoryRoot,
  environment,
  repository,
  branch,
  head,
  defaultBranch,
  workerNames,
  runs,
  deployments,
  versionDetails,
  recordedAt = new Date().toISOString(),
}) {
  const observationsWorker = assertStableWorkerName(workerNames.observations, "observations Worker");
  const stationWorker = assertStableWorkerName(workerNames.station, "station Worker");
  const cacheWorker = assertStableWorkerName(workerNames.cache, "cache Worker");
  const observationsRun = validateRun(runs.observations, WORKFLOWS.observations, defaultBranch, "observations");
  const stationRun = validateRun(runs.station, WORKFLOWS.station, defaultBranch, "station");
  const cacheV2Run = validateRun(runs.cacheV2, WORKFLOWS.cache, defaultBranch, "v2 cache");
  const cacheV3Run = validateRun(runs.cacheV3, WORKFLOWS.cache, defaultBranch, "v3 cache cut-over");
  const observationsVersion = parseWorkflowVersionId(observationsRun.log, "observations");
  const stationVersion = parseWorkflowVersionId(stationRun.log, "station");
  const cacheV2Version = parseWorkflowVersionId(cacheV2Run.log, "v2 cache");
  const cacheV3Version = parseWorkflowVersionId(cacheV3Run.log, "v3 cache cut-over");
  for (const [label, runRecord, expected] of [
    ["v2 cache", cacheV2Run, [`Resolved STATION_HISTORY Service Binding target: ${stationWorker}`, `Deployed cache Worker: ${cacheWorker}`, `Persistent observation-history authority: v2`]],
    ["v3 cache cut-over", cacheV3Run, [`Resolved STATION_HISTORY Service Binding target: ${stationWorker}-v3-candidate`, `Deployed cache Worker: ${cacheWorker}`, `Persistent observation-history authority: v3`]],
  ]) {
    for (const evidence of expected) if (!runRecord.log.includes(evidence)) throw new Error(`${label} log is missing exact binding/authority evidence`);
  }
  const observationsDeployment = selectDeployment(deployments.observations, observationsVersion, "observations");
  const stationDeployment = selectDeployment(deployments.station, stationVersion, "station");
  const cacheV2Deployment = selectDeployment(deployments.cache, cacheV2Version, "v2 cache");
  const cacheV3Deployment = selectDeployment(deployments.cache, cacheV3Version, "v3 cache cut-over");
  assertVersionDetail(versionDetails.observations, observationsVersion, "observations");
  assertVersionDetail(versionDetails.station, stationVersion, "station");
  assertVersionDetail(versionDetails.cacheV2, cacheV2Version, "v2 cache");
  assertVersionDetail(versionDetails.cacheV3, cacheV3Version, "v3 cache cut-over");
  assertStableDeploymentAtCutover({ deployments: deployments.observations, selectedDeployment: observationsDeployment, cutoverDeployment: cacheV3Deployment, label: "observations" });
  assertStableDeploymentAtCutover({ deployments: deployments.station, selectedDeployment: stationDeployment, cutoverDeployment: cacheV3Deployment, label: "station" });
  const cacheProvenance = assertHistoricalCacheSelection({
    deployments: deployments.cache,
    v2Deployment: cacheV2Deployment,
    v3Deployment: cacheV3Deployment,
    v2VersionDetail: versionDetails.cacheV2,
    preCutoverVersionDetail: versionDetails.cachePreCutover,
    v3VersionDetail: versionDetails.cacheV3,
    stableStationWorker: stationWorker,
    cacheWorker,
    cacheV2Run,
    cacheV3Run,
  });
  const preCutoverCacheRuntime = cacheProvenance.pre_cutover_v2_cache_runtime;
  const artifacts = [
    ["observations_deploy_workflow", WORKFLOWS.observations, observationsRun.head_sha],
    ["station_deploy_workflow", WORKFLOWS.station, stationRun.head_sha],
    ["cache_deploy_workflow", WORKFLOWS.cache, cacheV2Run.head_sha],
    ["cache_cutover_deploy_workflow", WORKFLOWS.cache, cacheV3Run.head_sha],
    ["observations_worker_config", "workers/uk_aq_observs_history_r2_api_worker/wrangler.toml", observationsRun.head_sha],
    ["station_worker_config", "workers/uk_aq_station_history/wrangler.toml", stationRun.head_sha],
    ["cache_worker_config", "workers/uk_aq_cache_proxy/wrangler.toml", cacheV2Run.head_sha],
    ["cache_binding_resolver", "workers/uk_aq_cache_proxy/resolve_station_history_service.sh", cacheV2Run.head_sha],
  ].map(([role, file, commit]) => gitBlobIdentity(repositoryRoot, role, file, commit));
  return {
    environment,
    repository,
    branch,
    repository_head: head,
    recorded_at_utc: recordedAt,
    history_version: "v2",
    index_authority_generation: "v2",
    integrity_version: "v2",
    cache_provenance: cacheProvenance,
    components: [
      component("stable_observations_worker", observationsWorker, observationsRun.head_sha, observationsVersion, observationsDeployment.id, observationsRun.id),
      component("stable_station_worker", stationWorker, stationRun.head_sha, stationVersion, stationDeployment.id, stationRun.id),
      component(
        "cache_worker",
        cacheWorker,
        cacheV2Run.head_sha,
        preCutoverCacheRuntime.version_id,
        preCutoverCacheRuntime.deployment_id,
        preCutoverCacheRuntime.workflow_run_id,
        cacheProvenance.transition_proof.baseline_differs_from_pre_cutover_runtime
          ? `Cloudflare secret-refresh version/deployment correlated with GitHub Actions v3 cut-over run ${preCutoverCacheRuntime.workflow_run_id}; code/runtime and non-value bindings match accepted v2 baseline run ${cacheV2Run.id}`
          : `GitHub Actions accepted v2 baseline run ${cacheV2Run.id} version UUID corroborated by the read-only Cloudflare Workers deployments and version-detail APIs`,
      ),
    ],
    artifacts,
    restore_steps: [
      { order: 1, role: "restore_observations_worker", kind: "command", description: "Restore the exact accepted stable observations-history Worker version to 100% using normal Cloudflare authentication loaded for an authorised rollback.", command_or_workflow: `npx wrangler versions deploy ${observationsVersion}@100% --name ${observationsWorker} -y` },
      { order: 2, role: "restore_station_worker", kind: "command", description: "Restore the exact accepted stable station-history Worker version to 100% using normal Cloudflare authentication loaded for an authorised rollback.", command_or_workflow: `npx wrangler versions deploy ${stationVersion}@100% --name ${stationWorker} -y` },
      { order: 3, role: "restore_v2_index_authority", kind: "command", description: "Restore persistent observation-history index authority to v2.", command_or_workflow: `gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --repo ${repository} --body v2` },
      { order: 4, role: "restore_cache_worker_v2_binding", kind: "command", description: "Restore the exact immediate pre-cutover v2-equivalent cache Worker version to 100% using normal Cloudflare authentication loaded for an authorised rollback; its accepted baseline provenance and stable station-history binding are proven by this record.", command_or_workflow: `npx wrangler versions deploy ${preCutoverCacheRuntime.version_id}@100% --name ${cacheWorker} -y` },
    ],
  };
}

function gh(args, repositoryRoot) {
  return run("gh", args, { cwd: repositoryRoot });
}

function githubContext(repositoryRoot) {
  const value = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], repositoryRoot));
  return { repository: value.nameWithOwner, defaultBranch: value.defaultBranchRef?.name };
}

function githubVariable(name, repository, repositoryRoot) {
  return gh(["variable", "get", name, "--repo", repository], repositoryRoot).trim();
}

function githubRun(id, repository, repositoryRoot) {
  const record = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${id}`], repositoryRoot));
  const jobsResult = JSON.parse(gh(["api", `repos/${repository}/actions/runs/${id}/jobs?per_page=100`], repositoryRoot));
  return {
    id: String(record.id),
    path: record.path,
    head_sha: record.head_sha,
    head_branch: record.head_branch,
    status: record.status,
    conclusion: record.conclusion,
    log: gh(["run", "view", String(id), "--repo", repository, "--log"], repositoryRoot),
    jobs: Array.isArray(jobsResult?.jobs) ? jobsResult.jobs : [],
  };
}

async function cloudflareGet(accountId, apiToken, suffix) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${suffix}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) throw new Error(`Read-only Cloudflare Workers API GET failed with HTTP ${response.status}`);
  return body.result;
}

async function workerDeployments(accountId, token, worker) {
  const result = await cloudflareGet(accountId, token, `${encodeURIComponent(worker)}/deployments`);
  const deployments = Array.isArray(result) ? result : result?.deployments;
  if (!Array.isArray(deployments)) throw new Error("Read-only Cloudflare Workers deployments response has an unexpected shape");
  return deployments;
}

async function workerVersion(accountId, token, worker, versionId) {
  return cloudflareGet(accountId, token, `${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`);
}

function parseArgs(argv) {
  const args = { mode: argv[0] || "", repositoryRoot: ".", replace: false, confirmFrozen: false };
  const values = new Set(["--plan-report", "--out", "--operator", "--repository-root", "--observations-run-id", "--station-run-id", "--cache-v2-run-id", "--cache-v3-cutover-run-id"]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--replace") args.replace = true;
    else if (flag === "--confirm-frozen") args.confirmFrozen = true;
    else if (values.has(flag)) {
      const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = requiredString(argv[++index], flag);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function assertEnvironment(localEnvironment, githubEnvironment) {
  const local = requiredString(localEnvironment, "UKAQ_ENV_NAME").toUpperCase();
  const remote = requiredString(githubEnvironment, "GitHub variable UKAQ_ENV_NAME").toUpperCase();
  if (!new Set(["TEST", "LIVE"]).has(local) || local !== remote) {
    throw new Error("Local and GitHub UKAQ_ENV_NAME must match and be TEST or LIVE");
  }
  return local;
}

export function sealAndPublish({ payload, kind, out, planReport, repositoryRoot, replace }) {
  const destination = path.resolve(out);
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) throw new Error(`Evidence output directory does not exist: ${parent}`);
  if (!replace && fs.existsSync(destination)) throw new Error(`Evidence output already exists; use --replace to replace it: ${destination}`);
  const temporaryDirectory = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}.capture-`));
  const payloadFile = path.join(temporaryDirectory, "payload.json");
  const sealedFile = path.join(temporaryDirectory, "sealed.json");
  try {
    fs.writeFileSync(payloadFile, `${JSON.stringify({ kind, payload }, null, 2)}\n`, { mode: 0o600 });
    const common = ["--repository-root", repositoryRoot];
    const plan = planReport ? ["--plan-report", planReport] : [];
    run(process.execPath, [SEALER, "seal", "--payload", payloadFile, "--out", sealedFile, ...plan, ...common], { cwd: repositoryRoot });
    run(process.execPath, [SEALER, "validate", "--evidence", sealedFile, ...plan, ...common], { cwd: repositoryRoot });
    if (replace) fs.renameSync(sealedFile, destination);
    else {
      fs.linkSync(sealedFile, destination);
      fs.unlinkSync(sealedFile);
    }
    fs.chmodSync(destination, 0o600);
    return destination;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function requireRunId(value, flag) {
  if (!/^[1-9][0-9]*$/.test(String(value || ""))) throw new Error(`${flag} is required and must be a GitHub Actions run ID`);
  return String(value);
}

export function cloudflareCaptureCredentials(environment) {
  return {
    observations: {
      accountId: requiredString(
        environment.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID || environment.CLOUDFLARE_ACCOUNT_ID,
        "UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID",
      ),
      apiToken: requiredString(
        environment.UK_AQ_R2_CLOUDFLARE_API_TOKEN || environment.CLOUDFLARE_API_TOKEN,
        "UK_AQ_R2_CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_TOKEN",
      ),
    },
    domain: {
      accountId: requiredString(
        environment.UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID
          || environment.UK_AQ_CACHE_CLOUDFLARE_ACCOUNT_ID
          || environment.CLOUDFLARE_ACCOUNT_ID,
        "UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID, UK_AQ_CACHE_CLOUDFLARE_ACCOUNT_ID, or CLOUDFLARE_ACCOUNT_ID",
      ),
      apiToken: requiredString(
        environment.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN
          || environment.UK_AQ_CACHE_CLOUDFLARE_API_TOKEN
          || environment.CLOUDFLARE_API_TOKEN,
        "UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN, UK_AQ_CACHE_CLOUDFLARE_API_TOKEN, or CLOUDFLARE_API_TOKEN",
      ),
    },
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseArgs(argv);
  if (!new Set(["writer-freeze", "v2-runtime-rollback"]).has(args.mode)) {
    throw new Error("Usage: index_v3_capture_operator_evidence.mjs writer-freeze --plan-report PLAN.json --out EVIDENCE.json --operator NAME --confirm-frozen [--replace] | v2-runtime-rollback --out EVIDENCE.json --observations-run-id ID --station-run-id ID --cache-v2-run-id ID --cache-v3-cutover-run-id ID [--replace]");
  }
  const repositoryRoot = path.resolve(args.repositoryRoot);
  assertCleanWorkingTree(repositoryRoot);
  const state = repositoryState(repositoryRoot);
  const github = githubContext(repositoryRoot);
  if (!github.repository || !github.defaultBranch || state.branch !== github.defaultBranch) {
    throw new Error("Capture must run on the GitHub default branch");
  }
  const captureEnvironment = assertEnvironment(environment.UKAQ_ENV_NAME, githubVariable("UKAQ_ENV_NAME", github.repository, repositoryRoot));
  let payload;
  let kind;
  if (args.mode === "writer-freeze") {
    const planReport = readJson(requiredString(args.planReport, "--plan-report"), "migration plan report");
    payload = buildWriterFreezePayload({ planReport, repositoryRoot, environment: captureEnvironment, repository: github.repository, branch: state.branch, head: state.head, operator: args.operator, confirmed: args.confirmFrozen });
    kind = "uk_aq_index_v3_writer_freeze_evidence";
  } else {
    const credentials = cloudflareCaptureCredentials(environment);
    const workerNames = {
      observations: githubVariable("UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME", github.repository, repositoryRoot),
      station: githubVariable("UK_AQ_STATION_HISTORY_WORKER_NAME", github.repository, repositoryRoot),
      cache: githubVariable("UK_AQ_CACHE_WORKER_NAME", github.repository, repositoryRoot),
    };
    const runs = {
      observations: githubRun(requireRunId(args.observationsRunId, "--observations-run-id"), github.repository, repositoryRoot),
      station: githubRun(requireRunId(args.stationRunId, "--station-run-id"), github.repository, repositoryRoot),
      cacheV2: githubRun(requireRunId(args.cacheV2RunId, "--cache-v2-run-id"), github.repository, repositoryRoot),
      cacheV3: githubRun(requireRunId(args.cacheV3CutoverRunId, "--cache-v3-cutover-run-id"), github.repository, repositoryRoot),
    };
    const deployments = {
      observations: await workerDeployments(credentials.observations.accountId, credentials.observations.apiToken, workerNames.observations),
      station: await workerDeployments(credentials.domain.accountId, credentials.domain.apiToken, workerNames.station),
      cache: await workerDeployments(credentials.domain.accountId, credentials.domain.apiToken, workerNames.cache),
    };
    const versionIds = {
      observations: parseWorkflowVersionId(runs.observations.log, "observations"),
      station: parseWorkflowVersionId(runs.station.log, "station"),
      cacheV2: parseWorkflowVersionId(runs.cacheV2.log, "v2 cache"),
      cacheV3: parseWorkflowVersionId(runs.cacheV3.log, "v3 cache cut-over"),
    };
    const cacheV3Deployment = selectDeployment(deployments.cache, versionIds.cacheV3, "v3 cache cut-over");
    const cachePreCutoverDeployment = immediateDeploymentBefore(deployments.cache, cacheV3Deployment, "cache");
    if (!isNormalFullDeployment(cachePreCutoverDeployment)) {
      throw new Error("Cache deployment immediately before v3 cut-over is not a normal single-version 100% deployment");
    }
    const cachePreCutoverVersionId = cachePreCutoverDeployment.versions[0].version_id;
    const versionDetails = {
      observations: await workerVersion(credentials.observations.accountId, credentials.observations.apiToken, workerNames.observations, versionIds.observations),
      station: await workerVersion(credentials.domain.accountId, credentials.domain.apiToken, workerNames.station, versionIds.station),
      cacheV2: await workerVersion(credentials.domain.accountId, credentials.domain.apiToken, workerNames.cache, versionIds.cacheV2),
      cachePreCutover: await workerVersion(credentials.domain.accountId, credentials.domain.apiToken, workerNames.cache, cachePreCutoverVersionId),
      cacheV3: await workerVersion(credentials.domain.accountId, credentials.domain.apiToken, workerNames.cache, versionIds.cacheV3),
    };
    payload = buildRollbackPayload({ repositoryRoot, environment: captureEnvironment, repository: github.repository, branch: state.branch, head: state.head, defaultBranch: github.defaultBranch, workerNames, runs, deployments, versionDetails });
    kind = "uk_aq_index_v3_v2_runtime_rollback_record";
  }
  const destination = sealAndPublish({ payload, kind, out: requiredString(args.out, "--out"), planReport: args.mode === "writer-freeze" ? args.planReport : "", repositoryRoot, replace: args.replace });
  process.stdout.write(`${JSON.stringify({ ok: true, mode: args.mode, out: destination, scheduler_state_proved: false })}\n`);
  if (args.mode === "writer-freeze") process.stderr.write("Writer-freeze evidence records the operator assertion and pinned entrypoints; it does not prove scheduler state. Preflight/post-cutover verification checks scheduler rows independently.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
