import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
  assert.match(stationWorkflow, /CANDIDATE_OBSERVATIONS_WORKER_NAME="\$\{UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME\}-v3-candidate"/);
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
  assert.match(migrationWrapper, /case "\$UK_AQ_R2_HISTORY_INDEX_VERSION" in/);
  assert.match(migrationWrapper, /\n  v2\)/);
  assert.match(migrationWrapper, /\n  v3\)/);
  assert.match(migrationWrapper, /GitHub variable \$variable_name/);
});

test("post-cutover smoke does not claim cache bypass proves a fresh inner MISS", () => {
  assert.match(postCutoverVerify, /routing\/data smoke/);
  assert.match(postCutoverVerify, /does not prove that the inner observations candidate performed a fresh cache MISS/);
  assert.match(postCutoverVerify, /EXACT V3 DEPENDENCY \/ GENERATION VERIFICATION/);
  assert.match(postCutoverVerify, /DEPLOYMENT \/ ROUTING SMOKE TEST/);
});

test("v2 runtime rollback evidence requires exact non-secret deployment and Git identities", () => {
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
      ["stable_observations_worker", "uk-aq-observs-history-r2-api-test", "11111111-1111-4111-8111-111111111111"],
      ["stable_station_worker", "uk-aq-station-history-test", "22222222-2222-4222-8222-222222222222"],
      ["cache_worker", "uk-aq-cache-test", "33333333-3333-4333-8333-333333333333"],
    ].map(([role, worker_name, version_id]) => ({
      role,
      worker_name,
      git_commit_sha: gitHead,
      deployment: { version_id, deployment_id: `deployment-${role}`, captured_by: "read-only Cloudflare versions API" },
    })),
    artifacts: [
      gitBlobIdentity("observations_deploy_workflow", ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml"),
      gitBlobIdentity("station_deploy_workflow", ".github/workflows/uk_aq_station_history_deploy.yml"),
      gitBlobIdentity("cache_deploy_workflow", ".github/workflows/uk_aq_cache_proxy_deploy.yml"),
      gitBlobIdentity("observations_worker_config", "workers/uk_aq_observs_history_r2_api_worker/wrangler.toml"),
      gitBlobIdentity("station_worker_config", "workers/uk_aq_station_history/wrangler.toml"),
      gitBlobIdentity("cache_worker_config", "workers/uk_aq_cache_proxy/wrangler.toml"),
      gitBlobIdentity("cache_binding_resolver", "workers/uk_aq_cache_proxy/resolve_station_history_service.sh"),
    ],
    restore_steps: [
      ["restore_observations_worker", "Deploy pinned stable observations Worker"],
      ["restore_station_worker", "Deploy pinned stable station Worker"],
      ["restore_v2_index_authority", "Restore persistent v2 observation authority"],
      ["restore_cache_worker_v2_binding", "Deploy cache with stable station binding"],
    ].map(([role, description], index) => ({
      order: index + 1,
      role,
      kind: index === 2 ? "command" : "github_workflow",
      description,
      command_or_workflow: index === 2 ? "gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --body v2" : "gh workflow run ... --ref <pinned-sha>",
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
    UK_AQ_OBSERVS_HISTORY_R2_API_URL: `https://${testWorkerName}-v3-candidate.account.workers.dev`,
  }));
  assert.throws(
    () => assertV3Candidate({
      ...baseEnv,
      UK_AQ_OBSERVS_HISTORY_R2_API_URL: `https://${liveWorkerName}-v3-candidate.account.workers.dev`,
    }),
    /requires the uk-aq-observs-history-r2-api-test-v3-candidate observations URL/,
  );
});
