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

function assertVersionDetail(detail, versionId, label) {
  if (!detail || detail.id !== versionId) throw new Error(`${label} Cloudflare version detail does not match the workflow UUID`);
}

function serviceBinding(detail, bindingName) {
  return (detail?.resources?.bindings || []).filter((binding) =>
    binding?.type === "service" && binding?.name === bindingName);
}

export function assertHistoricalCacheSelection({
  deployments,
  v2Deployment,
  v3Deployment,
  v2VersionDetail,
  v3VersionDetail,
  stableStationWorker,
}) {
  if (v2Deployment.id === v3Deployment.id) throw new Error("v2 and v3 cache deployment identities are identical");
  const ordered = [...deployments].sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
  const v3Index = ordered.findIndex((entry) => entry.id === v3Deployment.id);
  const v2Index = ordered.findIndex((entry) => entry.id === v2Deployment.id);
  if (v3Index < 0 || v2Index !== v3Index + 1) {
    throw new Error("Selected v2 cache deployment is not immediately before the explicit v3 cut-over deployment");
  }
  const v2Bindings = serviceBinding(v2VersionDetail, "STATION_HISTORY");
  const v3Bindings = serviceBinding(v3VersionDetail, "STATION_HISTORY");
  if (v2Bindings.length !== 1 || v2Bindings[0].service !== stableStationWorker) {
    throw new Error("Historical v2 cache version is not bound to the stable station-history Worker");
  }
  if (v3Bindings.length !== 1 || v3Bindings[0].service !== `${stableStationWorker}-v3-candidate`) {
    throw new Error("Explicit v3 cache cut-over version is not bound to the station-history candidate");
  }
}

const component = (role, workerName, commit, versionId, deploymentId, runId) => ({
  role,
  worker_name: workerName,
  git_commit_sha: commit,
  deployment: {
    version_id: versionId,
    deployment_id: deploymentId,
    captured_by: `GitHub Actions run ${runId} version UUID corroborated by the read-only Cloudflare Workers deployments and version-detail APIs`,
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
  assertHistoricalCacheSelection({
    deployments: deployments.cache,
    v2Deployment: cacheV2Deployment,
    v3Deployment: cacheV3Deployment,
    v2VersionDetail: versionDetails.cacheV2,
    v3VersionDetail: versionDetails.cacheV3,
    stableStationWorker: stationWorker,
  });
  const artifacts = [
    ["observations_deploy_workflow", WORKFLOWS.observations, observationsRun.head_sha],
    ["station_deploy_workflow", WORKFLOWS.station, stationRun.head_sha],
    ["cache_deploy_workflow", WORKFLOWS.cache, cacheV2Run.head_sha],
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
    components: [
      component("stable_observations_worker", observationsWorker, observationsRun.head_sha, observationsVersion, observationsDeployment.id, observationsRun.id),
      component("stable_station_worker", stationWorker, stationRun.head_sha, stationVersion, stationDeployment.id, stationRun.id),
      component("cache_worker", cacheWorker, cacheV2Run.head_sha, cacheV2Version, cacheV2Deployment.id, cacheV2Run.id),
    ],
    artifacts,
    restore_steps: [
      { order: 1, role: "restore_observations_worker", kind: "github_workflow", description: "Restore the accepted stable observations-history Worker from its pinned Git commit.", command_or_workflow: `gh workflow run ${path.basename(WORKFLOWS.observations)} --repo ${repository} --ref ${observationsRun.head_sha}` },
      { order: 2, role: "restore_station_worker", kind: "github_workflow", description: "Restore the accepted stable station-history Worker from its pinned Git commit.", command_or_workflow: `gh workflow run ${path.basename(WORKFLOWS.station)} --repo ${repository} --ref ${stationRun.head_sha}` },
      { order: 3, role: "restore_v2_index_authority", kind: "command", description: "Restore persistent observation-history index authority to v2.", command_or_workflow: `gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --repo ${repository} --body v2` },
      { order: 4, role: "restore_cache_worker_v2_binding", kind: "github_workflow", description: "Restore the accepted cache Worker version bound to stable v2 station history.", command_or_workflow: `gh workflow run ${path.basename(WORKFLOWS.cache)} --repo ${repository} --ref ${cacheV2Run.head_sha}` },
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
  return {
    id: String(record.id),
    path: record.path,
    head_sha: record.head_sha,
    head_branch: record.head_branch,
    status: record.status,
    conclusion: record.conclusion,
    log: gh(["run", "view", String(id), "--repo", repository, "--log"], repositoryRoot),
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
    const accountId = requiredString(environment.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
    const apiToken = requiredString(environment.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");
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
      observations: await workerDeployments(accountId, apiToken, workerNames.observations),
      station: await workerDeployments(accountId, apiToken, workerNames.station),
      cache: await workerDeployments(accountId, apiToken, workerNames.cache),
    };
    const versionIds = {
      observations: parseWorkflowVersionId(runs.observations.log, "observations"),
      station: parseWorkflowVersionId(runs.station.log, "station"),
      cacheV2: parseWorkflowVersionId(runs.cacheV2.log, "v2 cache"),
      cacheV3: parseWorkflowVersionId(runs.cacheV3.log, "v3 cache cut-over"),
    };
    const versionDetails = {
      observations: await workerVersion(accountId, apiToken, workerNames.observations, versionIds.observations),
      station: await workerVersion(accountId, apiToken, workerNames.station, versionIds.station),
      cacheV2: await workerVersion(accountId, apiToken, workerNames.cache, versionIds.cacheV2),
      cacheV3: await workerVersion(accountId, apiToken, workerNames.cache, versionIds.cacheV3),
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
