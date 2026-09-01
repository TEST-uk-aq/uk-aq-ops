import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertV3Candidate } from "../workers/uk_aq_station_history_v3_candidate/entry.mjs";
import { validateIndexV3OperatorEvidence } from "../scripts/index_v3_migration/index_v3_operator_evidence.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const preflight = read("scripts/index_v3_migration/index_v3_preflight.sh");
const postCutoverVerify = read("scripts/index_v3_migration/index_v3_post_cutover_verify.sh");
const migrationWrapper = read("scripts/index_v3_migration/index_v3_migration.sh");
const cacheWorkflow = read(".github/workflows/uk_aq_cache_proxy_deploy.yml");
const normalStationWorkflow = read(".github/workflows/uk_aq_station_history_deploy.yml");
const stationWorkflow = read(".github/workflows/uk_aq_station_history_v3_candidate_deploy.yml");
const observationsWorkflow = read(".github/workflows/uk_aq_observs_history_r2_api_v3_candidate_deploy.yml");
const stationWrangler = read("workers/uk_aq_station_history_v3_candidate/wrangler.toml");
const observationsWrangler = read("workers/uk_aq_observs_history_r2_api_v3_candidate/wrangler.toml");
const bindingResolver = fileURLToPath(new URL(
  "../workers/uk_aq_cache_proxy/resolve_station_history_service.sh",
  import.meta.url,
));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
}

const stableJson = (value) => `${JSON.stringify(stableObject(value), null, 2)}\n`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
const migrationTargetGitSha = "b8858d95c42ff52558cb0fa59413162d6bc12afa";

function shellArray(source, name) {
  const match = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)$`, "m"));
  assert.ok(match, `missing shell array: ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function gitStatus(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}
const gitBlobIdentity = (role, path) => {
  const body = spawnSync("git", ["cat-file", "blob", `${gitHead}:${path}`], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  return { role, path, git_commit_sha: gitHead, sha256: sha256(body) };
};

function evidenceEnvelope(kind, payload) {
  return { schema_version: 1, kind, payload, payload_sha256: sha256(stableJson(payload)) };
}

function resolveStationHistoryService(normalService, authorityGeneration, override = "") {
  return spawnSync("bash", [bindingResolver, normalService, authorityGeneration, override], {
    encoding: "utf8",
  });
}

function workflowStepIndex(stepName) {
  const index = cacheWorkflow.indexOf(`- name: ${stepName}`);
  assert.notEqual(index, -1, `missing workflow step: ${stepName}`);
  return index;
}

test("maintenance preflight follows the published site-mode marker contract", () => {
  const obsoleteWorkflow = ["UK AQ Edge Maintenance ", "Deploy"].join("");
  const obsoleteStatus = ["__uk_aq_site_", "mode.json"].join("");

  assert.doesNotMatch(preflight, new RegExp(obsoleteWorkflow));
  assert.doesNotMatch(preflight, new RegExp(obsoleteStatus.replace(".", "\\.")));
  assert.match(preflight, /uk-aq-site-mode\.json/);
  assert.match(preflight, /<meta name="uk-aq-site-maintenance" content="on">/);
  for (const route of ["/", "/hex_map/", "/about/", "/dev-blog/", "/resources/", "/sensor_map/", "/sensors/"]) {
    assert.ok(preflight.includes(route), `missing maintenance route ${route}`);
  }
});

test("Prune Daily preflight rejects every non-completed workflow state", () => {
  assert.match(preflight, /--limit 50 --json databaseId,status,conclusion,event,createdAt,url/);
  assert.match(preflight, /select\(\.status != "completed"\)/);
  assert.doesNotMatch(preflight, /--status in_progress/);
  for (const status of ["in_progress", "queued", "waiting"]) {
    assert.ok(preflight.includes(status), `missing self-test for ${status}`);
  }
});

test("candidate workflows derive TEST and LIVE identities from active Worker names", () => {
  const candidates = [
    ["uk-aq-station-history-test", "uk-aq-station-history-test-v3-candidate"],
    ["uk-aq-station-history-live", "uk-aq-station-history-live-v3-candidate"],
    ["uk-aq-observs-history-r2-api-test", "uk-aq-observs-history-r2-api-test-v3-candidate"],
    ["uk-aq-observs-history-r2-api-live", "uk-aq-observs-history-r2-api-live-v3-candidate"],
  ];
  for (const [activeName, expectedCandidate] of candidates) {
    assert.equal(`${activeName}-v3-candidate`, expectedCandidate);
  }

  assert.match(stationWorkflow, /UK_AQ_STATION_HISTORY_WORKER_NAME: \$\{\{ vars\.UK_AQ_STATION_HISTORY_WORKER_NAME \|\| '' \}\}/);
  assert.match(stationWorkflow, /CANDIDATE_WORKER_NAME="\$\{UK_AQ_STATION_HISTORY_WORKER_NAME\}-v3-candidate"/);
  assert.match(stationWorkflow, /CANDIDATE_OBSERVATIONS_WORKER_NAME="\$\{UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME\}-v3-leaf-candidate"/);
  assert.match(stationWorkflow, /CANDIDATE_OBSERVATIONS_URL_PATTERN="\^https:\/\//);
  assert.match(observationsWorkflow, /UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME: \$\{\{ vars\.UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME \|\| '' \}\}/);
  assert.match(observationsWorkflow, /CANDIDATE_WORKER_NAME=%s-v3-candidate/);
  assert.match(observationsWorkflow, /\*\-v3-candidate/);
  assert.doesNotMatch(stationWrangler, /^name\s*=/m);
  assert.doesNotMatch(observationsWrangler, /^name\s*=/m);
});

test("operator verification authenticates exact current dependencies under v2 or v3 authority", () => {
  for (const surface of [preflight, postCutoverVerify]) {
    assert.match(surface, /--mode verify/);
    assert.match(surface, /current_dependency_verify\.json/);
    assert.match(surface, /canonical Parquet/);
    assert.doesNotMatch(surface, /unique_by\(\.job_key\)/);
    assert.match(surface, /\(\.enabled \| type\) == "number"/);
  }
  assert.match(preflight, /compare_repo_var UK_AQ_R2_HISTORY_INTEGRITY_VERSION/);
  assert.match(postCutoverVerify, /UK_AQ_R2_HISTORY_INTEGRITY_VERSION/);
  assert.match(postCutoverVerify, /verification_failed_before_r2_comparison/);
  assert.match(postCutoverVerify, /VERIFY_FAILURE_CATEGORY/);
  assert.match(postCutoverVerify, /\.result\.failure_category/);
  assert.match(postCutoverVerify, /recovery_reconciliation\.counts\.fail == 0/);
  assert.match(migrationWrapper, /case "\$UK_AQ_R2_HISTORY_INDEX_VERSION" in/);
  assert.match(migrationWrapper, /\n  v2\)/);
  assert.match(migrationWrapper, /\n  v3\)/);
  assert.match(migrationWrapper, /GitHub variable \$variable_name/);
  assert.match(migrationWrapper, /VERIFY_CURRENT_TRUSTED_DEPENDENCIES=\(/);
  assert.match(migrationWrapper, /VERIFY_PINNED_HISTORICAL_SEMANTIC_DEPENDENCIES=\(/);
  assert.match(migrationWrapper, /workers\/shared\/uk_aq_observation_history_index_v3\.mjs/);
  assert.match(migrationWrapper, /current_verify_dependencies_are_trusted/);
  assert.match(migrationWrapper, /validate_read_only_dependency_authority/);
  assert.match(migrationWrapper, /verify mode does not accept --apply/);
  assert.match(migrationWrapper, /MUTATION_IMPLEMENTATION_SCOPES=\([\s\S]*scripts\/backup_r2/);
  const gateCall = postCutoverVerify.indexOf(
    '"$MIGRATION_WRAPPER" --verify-dependency-authority "$TARGET_WRITER_GIT_SHA"',
  );
  const directVerifier = postCutoverVerify.indexOf(
    "scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs",
  );
  assert.ok(gateCall >= 0, "post-cutover verifier does not invoke the shared dependency gate");
  assert.ok(directVerifier > gateCall, "migration verifier can run before dependency authority validation");
  assert.match(
    migrationWrapper,
    /if \[ "\$MODE" = "verify" \]; then\n\s+validate_read_only_dependency_authority "\$REPO_ROOT" "\$TARGET_WRITER_GIT_SHA"/,
  );
  const verifyAuthorityBranch = migrationWrapper.match(
    /if \[ "\$MODE" = "verify" \]; then[\s\S]*?\n  else/,
  );
  assert.ok(verifyAuthorityBranch);
  assert.doesNotMatch(verifyAuthorityBranch[0], /MUTATION_IMPLEMENTATION_SCOPES/);
});

test("read-only verify dependency classes match actual migration-to-HEAD history", () => {
  const currentTrusted = shellArray(migrationWrapper, "VERIFY_CURRENT_TRUSTED_DEPENDENCIES");
  const historicalSemantic = shellArray(
    migrationWrapper,
    "VERIFY_PINNED_HISTORICAL_SEMANTIC_DEPENDENCIES",
  );
  const mutationScopes = shellArray(migrationWrapper, "MUTATION_IMPLEMENTATION_SCOPES");
  const currentHead = gitStatus(repositoryRoot, ["rev-parse", "HEAD"]).stdout.trim();

  assert.equal(
    gitStatus(repositoryRoot, ["merge-base", "--is-ancestor", migrationTargetGitSha, currentHead]).status,
    0,
    "migration target is not an ancestor of current HEAD",
  );
  assert.notEqual(
    gitStatus(repositoryRoot, [
      "diff", "--quiet", migrationTargetGitSha, currentHead, "--", "workers/shared/r2_sigv4.mjs",
    ]).status,
    0,
    "real-history fixture no longer contains the reviewed r2_sigv4 evolution",
  );
  assert.equal(
    gitStatus(repositoryRoot, [
      "diff", "--quiet", migrationTargetGitSha, "--", ...historicalSemantic,
    ]).status,
    0,
    "prospective historically pinned semantic dependencies drift from the migration target",
  );
  for (const operationalDependency of [
    "workers/shared/r2_sigv4.mjs",
    "workers/shared/uk_aq_r2_history_writer.mjs",
    "scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
    "scripts/backup_r2/uk_aq_build_r2_history_index.mjs",
  ]) {
    assert.ok(currentTrusted.includes(operationalDependency));
    assert.ok(!historicalSemantic.includes(operationalDependency));
  }
  for (const dependency of historicalSemantic) {
    assert.ok(currentTrusted.includes(dependency), `historical dependency is not current-trusted: ${dependency}`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-index-v3-history-"));
  const cleanClone = path.join(temporaryRoot, "repo");
  try {
    const clone = gitStatus(repositoryRoot, ["clone", "--quiet", "--no-hardlinks", repositoryRoot, cleanClone]);
    assert.equal(clone.status, 0, clone.stderr);
    for (const dependency of currentTrusted) {
      assert.equal(
        gitStatus(cleanClone, ["ls-files", "--error-unmatch", "--", dependency]).status,
        0,
        `current trusted dependency is untracked: ${dependency}`,
      );
    }
    assert.equal(
      gitStatus(cleanClone, ["diff", "--quiet", "HEAD", "--", ...currentTrusted]).status,
      0,
      "committed current trusted dependencies are not clean against HEAD",
    );
    fs.appendFileSync(
      path.join(cleanClone, "workers/shared/r2_sigv4.mjs"),
      "\n// induced local verifier drift\n",
    );
    assert.notEqual(
      gitStatus(cleanClone, ["diff", "--quiet", "HEAD", "--", ...currentTrusted]).status,
      0,
      "induced local current-verifier drift was accepted",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  for (const mode of ["migrate", "resume"]) {
    assert.notEqual(
      gitStatus(repositoryRoot, [
        "diff", "--quiet", migrationTargetGitSha, currentHead, "--", ...mutationScopes,
      ]).status,
      0,
      `${mode} broad historical drift protection was weakened`,
    );
  }
});

test("post-cutover verifier requires only credentials it consumes", () => {
  assert.doesNotMatch(postCutoverVerify, /CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(postCutoverVerify, /CLOUDFLARE_API_TOKEN/);
  for (const name of [
    "CFLARE_R2_ENDPOINT",
    "CFLARE_R2_BUCKET",
    "CFLARE_R2_ACCESS_KEY_ID",
    "CFLARE_R2_SECRET_ACCESS_KEY",
  ]) {
    assert.match(postCutoverVerify, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(
    postCutoverVerify,
    /\b(?:printf|pass|warn|fail)\b[^\n]*\$(?:\{)?(?:CFLARE_R2_SECRET_ACCESS_KEY|UK_AQ_CACHE_BYPASS_SECRET)/,
  );
});

test("post-cutover smoke does not claim cache bypass proves a fresh inner MISS", () => {
  assert.match(postCutoverVerify, /routing\/data smoke/);
  assert.match(postCutoverVerify, /does not prove that the inner observations candidate performed a fresh cache MISS/);
  assert.match(postCutoverVerify, /EXACT V3 DEPENDENCY \/ GENERATION VERIFICATION/);
  assert.match(postCutoverVerify, /DEPLOYMENT \/ ROUTING SMOKE TEST/);
});

test("v2 runtime rollback evidence requires exact non-secret deployment and Git identities", () => {
  const cacheIdentity = ({ workflowRunId, versionId, versionNumber, deploymentId, createdOn, stationService }) => ({
    workflow_run_id: workflowRunId,
    git_commit_sha: gitHead,
    worker_name: "uk-aq-cache-test",
    version_id: versionId,
    version_number: versionNumber,
    version_created_on: createdOn,
    version_source: "wrangler",
    version_triggered_by: "version_upload",
    actor_identity_sha256: "a".repeat(64),
    script_etag: "b".repeat(64),
    script_handlers: ["fetch"],
    script_last_deployed_from: "wrangler",
    script_runtime: {
      compatibility_date: "2026-02-22",
      compatibility_flags: ["global_fetch_strictly_public"],
      usage_model: "standard",
    },
    binding_descriptors: [
      { name: "UK_AQ_CACHE_BYPASS_SECRET", type: "secret_text" },
      { name: "STATION_HISTORY", type: "service", service: stationService, environment: null },
    ],
    deployment_id: deploymentId,
    deployment_created_on: createdOn,
    deployment_source: "wrangler",
    deployment_strategy: "percentage",
    deployment_triggered_by: "deployment",
    deployment_percentage: 100,
    station_history_service: stationService,
  });
  const v2Cache = cacheIdentity({
    workflowRunId: "100",
    versionId: "33333333-3333-4333-8333-333333333333",
    versionNumber: 10,
    deploymentId: "44444444-4444-4444-8444-444444444444",
    createdOn: "2026-08-28T10:00:00.000Z",
    stationService: "uk-aq-station-history-test",
  });
  const v3Cache = cacheIdentity({
    workflowRunId: "101",
    versionId: "55555555-5555-4555-8555-555555555555",
    versionNumber: 11,
    deploymentId: "66666666-6666-4666-8666-666666666666",
    createdOn: "2026-08-28T11:00:00.000Z",
    stationService: "uk-aq-station-history-test-v3-candidate",
  });
  const payload = {
    environment: "TEST",
    repository: "TEST-uk-aq/uk-aq-ops",
    branch: "main",
    repository_head: gitHead,
    recorded_at_utc: "2026-08-28T12:00:00.000Z",
    history_version: "v2",
    index_authority_generation: "v2",
    integrity_version: "v2",
    components: [
      ["stable_observations_worker", "uk-aq-observs-history-r2-api-test", "11111111-1111-4111-8111-111111111111", "77777777-7777-4777-8777-777777777777"],
      ["stable_station_worker", "uk-aq-station-history-test", "22222222-2222-4222-8222-222222222222", "88888888-8888-4888-8888-888888888888"],
      ["cache_worker", "uk-aq-cache-test", "33333333-3333-4333-8333-333333333333", v2Cache.deployment_id],
    ].map(([role, worker_name, version_id, deployment_id]) => ({
      role,
      worker_name,
      git_commit_sha: gitHead,
      deployment: {
        version_id,
        deployment_id,
        captured_by: "read-only Cloudflare versions API",
      },
    })),
    cache_provenance: {
      accepted_v2_cache_baseline: v2Cache,
      pre_cutover_v2_cache_runtime: structuredClone(v2Cache),
      explicit_v3_cache_cutover: v3Cache,
      transition_proof: {
        kind: "accepted_v2_baseline_immediate_predecessor",
        baseline_differs_from_pre_cutover_runtime: false,
        pre_cutover_is_immediate_predecessor: true,
        script_identity_match: true,
        script_runtime_match: true,
        binding_descriptors_match: true,
        actor_identity_match: true,
        version_numbers_consecutive: true,
        workflow_correlation: null,
        explanation: "The accepted v2 deployment is the immediate predecessor to the explicit v3 cut-over.",
      },
    },
    artifacts: [
      gitBlobIdentity("observations_deploy_workflow", ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml"),
      gitBlobIdentity("station_deploy_workflow", ".github/workflows/uk_aq_station_history_deploy.yml"),
      gitBlobIdentity("cache_deploy_workflow", ".github/workflows/uk_aq_cache_proxy_deploy.yml"),
      gitBlobIdentity("cache_cutover_deploy_workflow", ".github/workflows/uk_aq_cache_proxy_deploy.yml"),
      gitBlobIdentity("observations_worker_config", "workers/uk_aq_observs_history_r2_api_worker/wrangler.toml"),
      gitBlobIdentity("station_worker_config", "workers/uk_aq_station_history/wrangler.toml"),
      gitBlobIdentity("cache_worker_config", "workers/uk_aq_cache_proxy/wrangler.toml"),
      gitBlobIdentity("cache_binding_resolver", "workers/uk_aq_cache_proxy/resolve_station_history_service.sh"),
    ],
    restore_steps: [
      ["restore_observations_worker", "Deploy pinned stable observations Worker", "npx wrangler versions deploy 11111111-1111-4111-8111-111111111111@100% --name uk-aq-observs-history-r2-api-test -y"],
      ["restore_station_worker", "Deploy pinned stable station Worker", "npx wrangler versions deploy 22222222-2222-4222-8222-222222222222@100% --name uk-aq-station-history-test -y"],
      ["restore_v2_index_authority", "Restore persistent v2 observation authority", "gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --repo TEST-uk-aq/uk-aq-ops --body v2"],
      ["restore_cache_worker_v2_binding", "Deploy cache with stable station binding", `npx wrangler versions deploy ${v2Cache.version_id}@100% --name ${v2Cache.worker_name} -y`],
    ].map(([role, description, command_or_workflow], index) => ({
      order: index + 1,
      role,
      kind: "command",
      description,
      command_or_workflow,
    })),
  };
  const evidence = evidenceEnvelope("uk_aq_index_v3_v2_runtime_rollback_record", payload);
  assert.equal(validateIndexV3OperatorEvidence({ evidence, repositoryRoot }).ok, true);

  const unavailable = structuredClone(evidence);
  unavailable.payload.components[0].deployment.version_id = "unavailable";
  unavailable.payload_sha256 = sha256(stableJson(unavailable.payload));
  assert.throws(
    () => validateIndexV3OperatorEvidence({ evidence: unavailable, repositoryRoot }),
    /exact Cloudflare version identity is unavailable/,
  );
});

test("writer-freeze evidence exactly covers scheduled and manually started mutation classes", () => {
  const planSha = "a".repeat(64);
  const definitions = [
    {
      id: "prune_daily_phase_b",
      kind: "scheduled_workflow",
      evidence_files: [
        "cloudflare/scheduler/jobs.toml",
        ".github/workflows/uk_aq_prune_daily.yml",
        "workers/uk_aq_prune_daily/phase_b_history_r2.mjs",
      ],
    },
    {
      id: "write_enabled_integrity",
      kind: "coordinated_external_runner",
      evidence_files: [
        "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
        "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-runner.sh",
        "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs",
      ],
    },
  ];
  const planReport = {
    result: {
      migration_run_id: "fixture-run",
      plan_sha256: planSha,
      writer_freeze_plan: { entries: definitions },
    },
  };
  const payload = {
    environment: "TEST",
    repository: "TEST-uk-aq/uk-aq-ops",
    branch: "main",
    repository_head: gitHead,
    migration_run_id: "fixture-run",
    plan_sha256: planSha,
    confirmed_at_utc: "2026-08-28T12:00:00.000Z",
    operator: "fixture-operator",
    resume_boundary: "accepted_v3_cutover_or_completed_v2_rollback",
    entries: definitions.map((definition) => ({
      id: definition.id,
      control: definition.kind === "scheduled_workflow" ? "scheduler_and_workflow" : "manual_operator_freeze",
      frozen: true,
      operator_assertion: "This entry point will not be started before the recorded resume boundary.",
      entrypoints: definition.evidence_files.map((artifactPath) => gitBlobIdentity("mutation_entrypoint", artifactPath)),
    })),
  };
  const evidence = evidenceEnvelope("uk_aq_index_v3_writer_freeze_evidence", payload);
  assert.equal(validateIndexV3OperatorEvidence({ evidence, repositoryRoot, planReport }).ok, true);

  const incomplete = structuredClone(evidence);
  incomplete.payload.entries.pop();
  incomplete.payload_sha256 = sha256(stableJson(incomplete.payload));
  assert.throws(
    () => validateIndexV3OperatorEvidence({ evidence: incomplete, repositoryRoot, planReport }),
    /does not cover exactly the declared mutation classes/,
  );
});

test("persistent v2 authority with no override selects the normal Worker", () => {
  const result = resolveStationHistoryService("uk-aq-station-history-test", "v2");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "uk-aq-station-history-test");
});

test("persistent v3 authority with no override selects the derived candidate", () => {
  const result = resolveStationHistoryService("uk-aq-station-history-test", "v3");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "uk-aq-station-history-test-v3-candidate");
});

test("TEST and LIVE station-history targets derive independently", () => {
  for (const normalService of [
    "uk-aq-station-history-test",
    "uk-aq-station-history-live",
  ]) {
    const v2 = resolveStationHistoryService(normalService, "v2");
    const v3 = resolveStationHistoryService(normalService, "v3");
    assert.equal(v2.status, 0, v2.stderr);
    assert.equal(v3.status, 0, v3.stderr);
    assert.equal(v2.stdout.trim(), normalService);
    assert.equal(v3.stdout.trim(), `${normalService}-v3-candidate`);
  }
});

test("arbitrary station-history Worker overrides remain rejected", () => {
  for (const authorityGeneration of ["v2", "v3"]) {
    const result = resolveStationHistoryService(
      "uk-aq-station-history-test",
      authorityGeneration,
      "uk-aq-arbitrary-third-worker",
    );
    assert.notEqual(result.status, 0);
  }
});

test("double-suffixed station-history candidates remain rejected", () => {
  const result = resolveStationHistoryService(
    "uk-aq-station-history-test",
    "v3",
    "uk-aq-station-history-test-v3-candidate-v3-candidate",
  );
  assert.notEqual(result.status, 0);
});

test("manual station-history overrides cannot contradict persistent authority", () => {
  const matchingSelections = [
    ["v2", "uk-aq-station-history-test"],
    ["v3", "uk-aq-station-history-test-v3-candidate"],
  ];
  for (const [authorityGeneration, override] of matchingSelections) {
    const result = resolveStationHistoryService(
      "uk-aq-station-history-test",
      authorityGeneration,
      override,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), override);
  }

  const oppositeSelections = [
    ["v2", "uk-aq-station-history-test-v3-candidate"],
    ["v3", "uk-aq-station-history-test"],
  ];
  for (const [authorityGeneration, override] of oppositeSelections) {
    const result = resolveStationHistoryService(
      "uk-aq-station-history-test",
      authorityGeneration,
      override,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /persistent authority/);
  }

  for (const authorityGeneration of ["", "v1", "v4"]) {
    const result = resolveStationHistoryService(
      "uk-aq-station-history-test",
      authorityGeneration,
    );
    assert.notEqual(result.status, 0);
  }
});

test("an ordinary cache-proxy push preserves persistent v3 reader authority", () => {
  const result = resolveStationHistoryService("uk-aq-station-history-test", "v3");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "uk-aq-station-history-test-v3-candidate");

  assert.match(cacheWorkflow, /push:/);
  assert.match(cacheWorkflow, /UK_AQ_R2_HISTORY_INDEX_VERSION: \$\{\{ vars\.UK_AQ_R2_HISTORY_INDEX_VERSION \|\| '' \}\}/);
  assert.match(cacheWorkflow, /"\$\{UK_AQ_R2_HISTORY_INDEX_VERSION\}"/);
  assert.doesNotMatch(cacheWorkflow, /UK_AQ_R2_HISTORY_INDEX_VERSION[^\n]*\|\| 'v2'/);
});

test("all cache deployment prerequisites precede the authority-changing deploy", () => {
  const orderedSteps = [
    "Validate cache deployment identity and Cloudflare credentials",
    "Resolve STATION_HISTORY Service Binding target",
    "Validate required Worker secrets and vars",
    "Prepare and validate Worker secrets payload",
    "Validate Worker deployment package",
    "Verify existing operational Workers",
    "Apply Worker secrets to existing cache Worker",
    "Deploy Worker",
  ];
  const positions = orderedSteps.map(workflowStepIndex);
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index - 1] < positions[index],
      `${orderedSteps[index - 1]} must precede ${orderedSteps[index]}`,
    );
  }

  assert.match(cacheWorkflow, /missing_secrets=\(\)/);
  assert.match(cacheWorkflow, /missing_vars=\(\)/);
  assert.match(cacheWorkflow, /jq -e 'type == "object" and length > 0/);
  assert.match(cacheWorkflow, /--dry-run/);
  assert.match(cacheWorkflow, /versions list/);
  assert.match(cacheWorkflow, /verify_existing_worker/);
  assert.match(cacheWorkflow, /This operational workflow does not bootstrap Workers/);
  assert.match(cacheWorkflow, /"\$\{STATION_HISTORY_SERVICE\}"/);
});

test("cache secrets are prepared and applied before one operational binding deploy", () => {
  const deploymentCommand = /command: deploy --config wrangler\.deploy\.toml --name \$\{\{ env\.UK_AQ_CACHE_WORKER_NAME \}\}/g;
  const deployments = cacheWorkflow.match(deploymentCommand) || [];
  assert.equal(deployments.length, 1);
  assert.doesNotMatch(cacheWorkflow, /Deploy Worker \(base\)/);

  const prepareIndex = workflowStepIndex("Prepare and validate Worker secrets payload");
  const applyIndex = workflowStepIndex("Apply Worker secrets to existing cache Worker");
  const deployIndex = workflowStepIndex("Deploy Worker");
  assert.ok(prepareIndex < applyIndex);
  assert.ok(applyIndex < deployIndex);
  assert.match(cacheWorkflow.slice(applyIndex, deployIndex), /for attempt in 1 2 3/);
  assert.match(cacheWorkflow.slice(applyIndex, deployIndex), /wrangler@4 secret bulk/);
});

test("no prerequisite failure gate remains after the authority-changing deploy", () => {
  const deployIndex = workflowStepIndex("Deploy Worker");
  const afterDeploy = cacheWorkflow.slice(deployIndex);
  assert.doesNotMatch(afterDeploy, /missing_secrets|missing_vars|jq -e|versions list|secret bulk/);
  assert.match(afterDeploy, /Report deployed STATION_HISTORY target/);
});

test("rollback to persistent v2 authority restores the normal default", () => {
  const cutover = resolveStationHistoryService("uk-aq-station-history-test", "v3");
  const rollback = resolveStationHistoryService("uk-aq-station-history-test", "v2");
  assert.equal(cutover.status, 0, cutover.stderr);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(cutover.stdout.trim(), "uk-aq-station-history-test-v3-candidate");
  assert.equal(rollback.stdout.trim(), "uk-aq-station-history-test");
});

test("the stable station-history Worker variable remains the normal deployment identity", () => {
  assert.match(cacheWorkflow, /station_history_service_override:/);
  assert.match(cacheWorkflow, /STATION_HISTORY_SERVICE_OVERRIDE: \$\{\{ inputs\.station_history_service_override \|\| '' \}\}/);
  assert.match(cacheWorkflow, /bash \.\/resolve_station_history_service\.sh/);
  assert.match(cacheWorkflow, /UK_AQ_STATION_HISTORY_WORKER_NAME: \$\{\{ vars\.UK_AQ_STATION_HISTORY_WORKER_NAME \|\| '' \}\}/);
  assert.match(normalStationWorkflow, /command: deploy --name \$\{\{ env\.UK_AQ_STATION_HISTORY_WORKER_NAME \}\}/);
  assert.match(stationWorkflow, /CANDIDATE_WORKER_NAME="\$\{UK_AQ_STATION_HISTORY_WORKER_NAME\}-v3-candidate"/);
  assert.doesNotMatch(cacheWorkflow, /vars\.STATION_HISTORY_SERVICE_OVERRIDE|vars\.station_history_service_override/);
});

test("station candidate accepts only its environment-specific observations candidate", () => {
  const testWorkerName = "uk-aq-observs-history-r2-api-test";
  const liveWorkerName = "uk-aq-observs-history-r2-api-live";
  const baseEnv = {
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3",
    UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME: testWorkerName,
  };

  assert.doesNotThrow(() => assertV3Candidate({
    ...baseEnv,
    UK_AQ_OBSERVS_HISTORY_R2_API_URL: `https://${testWorkerName}-v3-leaf-candidate.account.workers.dev`,
  }));
  for (const authority of ["V3", " v3", "v3 "]) {
    assert.throws(
      () => assertV3Candidate({
        ...baseEnv,
        UK_AQ_R2_HISTORY_INDEX_VERSION: authority,
        UK_AQ_OBSERVS_HISTORY_R2_API_URL: `https://${testWorkerName}-v3-leaf-candidate.account.workers.dev`,
      }),
      /requires index generation v3/,
    );
  }
  assert.throws(
    () => assertV3Candidate({
      ...baseEnv,
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: `https://${liveWorkerName}-v3-leaf-candidate.account.workers.dev`,
    }),
    /requires the uk-aq-observs-history-r2-api-test-v3-leaf-candidate observations URL/,
  );
});
