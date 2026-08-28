import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertCleanWorkingTree,
  assertStableDeploymentAtCutover,
  buildRollbackPayload,
  buildWriterFreezePayload,
  cloudflareCaptureCredentials,
  gitBlobIdentity,
  sealAndPublish,
} from "../scripts/index_v3_migration/index_v3_capture_operator_evidence.mjs";
import { validateIndexV3OperatorEvidence } from "../scripts/index_v3_migration/index_v3_operator_evidence.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(new URL("../scripts/index_v3_migration/index_v3_capture_operator_evidence.mjs", import.meta.url), "utf8");
const gitHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
const parentGitHead = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
}

const stableJson = (value) => `${JSON.stringify(stableObject(value), null, 2)}\n`;
const evidence = (kind, payload) => ({
  schema_version: 1,
  kind,
  payload,
  payload_sha256: crypto.createHash("sha256").update(stableJson(payload)).digest("hex"),
});

const planReport = {
  result: {
    migration_run_id: "fixture-run",
    plan_sha256: "a".repeat(64),
    environment: { environment: "TEST" },
    writer_freeze_plan: {
      entries: [
        {
          id: "prune_daily_phase_b",
          kind: "scheduled_workflow",
          evidence_files: [
            "cloudflare/scheduler/jobs.toml",
            ".github/workflows/uk_aq_prune_daily.yml",
          ],
        },
        {
          id: "write_enabled_integrity",
          kind: "coordinated_external_runner",
          evidence_files: [
            "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py",
          ],
        },
      ],
    },
  },
};

function writerPayload(report = planReport, confirmed = true) {
  return buildWriterFreezePayload({
    planReport: report,
    repositoryRoot,
    environment: "TEST",
    repository: "TEST-uk-aq/uk-aq-ops",
    branch: "main",
    head: gitHead,
    operator: "fixture-operator",
    confirmed,
    confirmedAt: "2026-08-28T12:00:00.000Z",
  });
}

test("writer-freeze builder derives exact classes, controls, and HEAD blobs from the plan", () => {
  const payload = writerPayload();
  assert.deepEqual(payload.entries.map(({ id }) => id), ["prune_daily_phase_b", "write_enabled_integrity"]);
  assert.deepEqual(payload.entries.map(({ control }) => control), ["scheduler_and_workflow", "manual_operator_freeze"]);
  assert.ok(payload.entries.every(({ frozen, entrypoints }) => frozen && entrypoints.every(({ git_commit_sha }) => git_commit_sha === gitHead)));
  assert.equal(validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_writer_freeze_evidence", payload),
    repositoryRoot,
    planReport,
  }).ok, true);
});

test("writer-freeze capture fails for missing confirmation and duplicate plan classes", () => {
  assert.throws(() => writerPayload(planReport, false), /explicit --confirm-frozen/);
  const duplicate = structuredClone(planReport);
  duplicate.result.writer_freeze_plan.entries.push(structuredClone(duplicate.result.writer_freeze_plan.entries[0]));
  assert.throws(() => writerPayload(duplicate), /duplicates writer-freeze class/);
});

test("writer-freeze validation rejects missing classes, altered paths, and altered blob hashes", () => {
  const base = writerPayload();
  for (const [mutate, expected] of [
    [(payload) => payload.entries.pop(), /does not cover exactly/],
    [(payload) => { payload.entries[0].entrypoints[0].path = "README.md"; }, /entrypoints differ/],
    [(payload) => { payload.entries[0].entrypoints[0].sha256 = "0".repeat(64); }, /does not match its pinned Git blob/],
  ]) {
    const payload = structuredClone(base);
    mutate(payload);
    assert.throws(() => validateIndexV3OperatorEvidence({
      evidence: evidence("uk_aq_index_v3_writer_freeze_evidence", payload),
      repositoryRoot,
      planReport,
    }), expected);
  }
});

test("dirty Git working tree prevents capture", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "index-v3-capture-dirty-"));
  try {
    spawnSync("git", ["init", "--quiet"], { cwd: temporaryRoot });
    fs.writeFileSync(path.join(temporaryRoot, "dirty.txt"), "untracked\n");
    assert.throws(() => assertCleanWorkingTree(temporaryRoot), /clean Git working tree/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("sealing validates before atomic publication and refuses overwrite without replace", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "index-v3-capture-publish-"));
  const planPath = path.join(temporaryRoot, "plan.json");
  const out = path.join(temporaryRoot, "freeze-evidence.json");
  try {
    fs.writeFileSync(planPath, JSON.stringify(planReport));
    const options = {
      payload: writerPayload(),
      kind: "uk_aq_index_v3_writer_freeze_evidence",
      out,
      planReport: planPath,
      repositoryRoot,
      replace: false,
    };
    assert.equal(sealAndPublish(options), out);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).kind, options.kind);
    assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), ["freeze-evidence.json", "plan.json"]);
    assert.throws(() => sealAndPublish(options), /already exists/);
    assert.equal(sealAndPublish({ ...options, replace: true }), out);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

const ids = {
  observationsVersion: uuid("1"),
  stationVersion: uuid("2"),
  cacheV2Version: uuid("3"),
  cacheV3Version: uuid("4"),
  cacheRefreshVersion: uuid("9"),
  observationsDeployment: uuid("5"),
  stationDeployment: uuid("6"),
  cacheV2Deployment: uuid("7"),
  cacheV3Deployment: uuid("8"),
  cacheRefreshDeployment: uuid("a"),
};

const deployment = (id, versionId, createdOn) => ({
  id,
  created_on: createdOn,
  source: "wrangler",
  strategy: "percentage",
  annotations: { "workers/triggered_by": "deployment" },
  versions: [{ percentage: 100, version_id: versionId }],
});

function cacheVersionDetail(id, number, createdOn, stationService, triggeredBy = "version_upload") {
  return {
    id,
    number,
    annotations: { "workers/triggered_by": triggeredBy },
    metadata: {
      author_id: "fixture-author",
      author_email: "fixture@example.invalid",
      created_on: createdOn,
      source: "wrangler",
    },
    resources: {
      bindings: [
        { name: "FIXTURE_VALUE", type: "secret_text" },
        { name: "STATION_HISTORY", type: "service", service: stationService, environment: "production" },
      ],
      script: { etag: "f".repeat(64), handlers: ["fetch"], last_deployed_from: "wrangler" },
      script_runtime: { compatibility_date: "2026-02-22", compatibility_flags: ["global_fetch_strictly_public"], usage_model: "standard" },
    },
  };
}

function interveningDeploymentEvents(selectedVersion) {
  return [
    {
      id: uuid("c"),
      created_on: "2026-08-28T10:20:00Z",
      versions: [
        { percentage: 50, version_id: selectedVersion },
        { percentage: 50, version_id: uuid("d") },
      ],
    },
    {
      id: uuid("e"),
      created_on: "2026-08-28T10:30:00Z",
      versions: [
        { percentage: 34, version_id: selectedVersion },
        { percentage: 33, version_id: uuid("f") },
        { percentage: 33, version_id: uuid("a") },
      ],
    },
    {
      ...deployment(uuid("b"), selectedVersion, "2026-08-28T10:40:00Z"),
      source: "rollback",
    },
  ];
}

function run(id, workflow, versionId, extras = "") {
  return {
    id,
    path: `${workflow}@refs/heads/main`,
    head_sha: gitHead,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    log: `Current Version ID: ${versionId}\n${extras}`,
    jobs: [],
  };
}

function rollbackFixture(overrides = {}) {
  const station = "uk-aq-station-history-test";
  const workerNames = {
    observations: "uk-aq-observs-history-r2-api-test",
    station,
    cache: "uk-aq-cache-test",
    ...overrides.workerNames,
  };
  const runs = {
    observations: run("101", ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml", ids.observationsVersion),
    station: run("102", ".github/workflows/uk_aq_station_history_deploy.yml", ids.stationVersion),
    cacheV2: run("103", ".github/workflows/uk_aq_cache_proxy_deploy.yml", ids.cacheV2Version, `Resolved STATION_HISTORY Service Binding target: ${station}\nDeployed cache Worker: uk-aq-cache-test\nPersistent observation-history authority: v2\n`),
    cacheV3: run("104", ".github/workflows/uk_aq_cache_proxy_deploy.yml", ids.cacheV3Version, `Resolved STATION_HISTORY Service Binding target: ${station}-v3-candidate\nDeployed cache Worker: uk-aq-cache-test\nPersistent observation-history authority: v3\n`),
    ...overrides.runs,
  };
  const deployments = {
    observations: [deployment(ids.observationsDeployment, ids.observationsVersion, "2026-08-28T09:00:00Z")],
    station: [deployment(ids.stationDeployment, ids.stationVersion, "2026-08-28T09:15:00Z")],
    cache: [
      deployment(ids.cacheV3Deployment, ids.cacheV3Version, "2026-08-28T11:00:00Z"),
      deployment(ids.cacheV2Deployment, ids.cacheV2Version, "2026-08-28T10:00:00Z"),
    ],
    ...overrides.deployments,
  };
  const versionDetails = {
    observations: { id: ids.observationsVersion, resources: { bindings: [] } },
    station: { id: ids.stationVersion, resources: { bindings: [] } },
    cacheV2: cacheVersionDetail(ids.cacheV2Version, 10, "2026-08-28T10:00:00Z", station),
    cachePreCutover: cacheVersionDetail(ids.cacheV2Version, 10, "2026-08-28T10:00:00Z", station),
    cacheV3: cacheVersionDetail(ids.cacheV3Version, 11, "2026-08-28T11:00:00Z", `${station}-v3-candidate`),
    ...overrides.versionDetails,
  };
  return { workerNames, runs, deployments, versionDetails };
}

function rollbackPayload(overrides = {}) {
  return buildRollbackPayload({
    repositoryRoot,
    environment: "TEST",
    repository: "TEST-uk-aq/uk-aq-ops",
    branch: "main",
    head: gitHead,
    defaultBranch: "main",
    ...rollbackFixture(overrides),
    recordedAt: "2026-08-28T12:00:00.000Z",
  });
}

function secretRefreshOverrides() {
  const fixture = rollbackFixture();
  const refreshDeployment = {
    ...deployment(ids.cacheRefreshDeployment, ids.cacheRefreshVersion, "2026-08-28T10:50:00Z"),
    annotations: { "workers/triggered_by": "secret" },
  };
  const cacheV3 = structuredClone(fixture.runs.cacheV3);
  cacheV3.jobs = [{
    name: "deploy-worker",
    steps: [
      {
        number: 9,
        name: "Apply Worker secrets to existing cache Worker",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-28T10:49:00Z",
        completed_at: "2026-08-28T10:51:00Z",
      },
      {
        number: 10,
        name: "Deploy Worker",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-28T10:51:00Z",
        completed_at: "2026-08-28T11:01:00Z",
      },
    ],
  }];
  return {
    runs: { cacheV3 },
    deployments: { cache: [fixture.deployments.cache[0], refreshDeployment, fixture.deployments.cache[1]] },
    versionDetails: {
      cachePreCutover: cacheVersionDetail(
        ids.cacheRefreshVersion,
        11,
        refreshDeployment.created_on,
        fixture.workerNames.station,
        "secret",
      ),
      cacheV3: cacheVersionDetail(ids.cacheV3Version, 12, "2026-08-28T11:00:00Z", `${fixture.workerNames.station}-v3-candidate`),
    },
  };
}

test("rollback builder accepts only stable Workers and emits all exact roles and restore steps", () => {
  const payload = rollbackPayload();
  assert.deepEqual(payload.components.map(({ role }) => role), ["stable_observations_worker", "stable_station_worker", "cache_worker"]);
  assert.deepEqual(payload.components.map(({ deployment }) => deployment.version_id), [
    ids.observationsVersion,
    ids.stationVersion,
    ids.cacheV2Version,
  ]);
  assert.deepEqual(payload.artifacts.map(({ role }) => role), [
    "observations_deploy_workflow",
    "station_deploy_workflow",
    "cache_deploy_workflow",
    "cache_cutover_deploy_workflow",
    "observations_worker_config",
    "station_worker_config",
    "cache_worker_config",
    "cache_binding_resolver",
  ]);
  assert.equal(payload.cache_provenance.accepted_v2_cache_baseline.version_id, ids.cacheV2Version);
  assert.equal(payload.cache_provenance.pre_cutover_v2_cache_runtime.version_id, ids.cacheV2Version);
  assert.equal(payload.cache_provenance.explicit_v3_cache_cutover.version_id, ids.cacheV3Version);
  assert.equal(payload.cache_provenance.transition_proof.kind, "accepted_v2_baseline_immediate_predecessor");
  assert.deepEqual(payload.restore_steps.map(({ order }) => order), [1, 2, 3, 4]);
  assert.deepEqual(payload.restore_steps.map(({ role }) => role), [
    "restore_observations_worker",
    "restore_station_worker",
    "restore_v2_index_authority",
    "restore_cache_worker_v2_binding",
  ]);
  assert.deepEqual(payload.restore_steps.map(({ kind }) => kind), ["command", "command", "command", "command"]);
  assert.equal(
    payload.restore_steps[0].command_or_workflow,
    `npx wrangler versions deploy ${ids.observationsVersion}@100% --name uk-aq-observs-history-r2-api-test -y`,
  );
  assert.equal(
    payload.restore_steps[1].command_or_workflow,
    `npx wrangler versions deploy ${ids.stationVersion}@100% --name uk-aq-station-history-test -y`,
  );
  assert.equal(
    payload.restore_steps[2].command_or_workflow,
    "gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --repo TEST-uk-aq/uk-aq-ops --body v2",
  );
  assert.equal(
    payload.restore_steps[3].command_or_workflow,
    `npx wrangler versions deploy ${ids.cacheV2Version}@100% --name uk-aq-cache-test -y`,
  );
  assert.ok(payload.restore_steps.filter(({ role }) => role !== "restore_v2_index_authority")
    .every(({ command_or_workflow }) => command_or_workflow.includes("@100%")));
  assert.ok(payload.restore_steps.every(({ command_or_workflow }) => !command_or_workflow.includes("-v3-candidate")));
  assert.ok(payload.restore_steps.every(({ command_or_workflow }) => !/gh workflow run .*--ref [0-9a-f]{40}/.test(command_or_workflow)));
  assert.ok(!payload.restore_steps[3].command_or_workflow.includes(ids.cacheV3Version));
  assert.equal(validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", payload),
    repositoryRoot,
  }).ok, true);
  assert.throws(() => rollbackPayload({ workerNames: { cache: "uk-aq-cache-test-v3-candidate" } }), /not a stable Worker identity/);
});

test("observations stable deployment must have no later deployment event through cut-over", () => {
  const selected = deployment(ids.observationsDeployment, ids.observationsVersion, "2026-08-28T10:00:00Z");
  const afterCutover = deployment(uuid("a"), uuid("a"), "2026-08-28T12:00:00Z");
  const cutover = deployment(ids.cacheV3Deployment, ids.cacheV3Version, "2026-08-28T11:00:00Z");
  assert.doesNotThrow(() => assertStableDeploymentAtCutover({
    deployments: [afterCutover, selected], selectedDeployment: selected, cutoverDeployment: cutover, label: "observations",
  }));
  assert.doesNotThrow(() => assertStableDeploymentAtCutover({
    deployments: [{ ...afterCutover, id: "invalid" }, selected], selectedDeployment: selected, cutoverDeployment: cutover, label: "observations",
  }));

  const superseding = deployment(uuid("b"), uuid("b"), "2026-08-28T10:30:00Z");
  assert.throws(() => assertStableDeploymentAtCutover({
    deployments: [selected, superseding], selectedDeployment: selected, cutoverDeployment: cutover, label: "observations",
  }), /superseded before/);
  for (const event of interveningDeploymentEvents(ids.observationsVersion)) {
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [event, selected], selectedDeployment: selected, cutoverDeployment: cutover, label: "observations",
    }), /superseded before/);
  }

  assert.throws(() => assertStableDeploymentAtCutover({
    deployments: [afterCutover], selectedDeployment: afterCutover, cutoverDeployment: cutover, label: "observations",
  }), /after the v3 cache cut-over/);
});

test("station stable deployment must have no later deployment event through cut-over", () => {
  const selected = deployment(ids.stationDeployment, ids.stationVersion, "2026-08-28T10:00:00Z");
  const afterCutover = deployment(uuid("a"), uuid("a"), "2026-08-28T12:00:00Z");
  const cutover = deployment(ids.cacheV3Deployment, ids.cacheV3Version, "2026-08-28T11:00:00Z");
  assert.doesNotThrow(() => assertStableDeploymentAtCutover({
    deployments: [selected, afterCutover], selectedDeployment: selected, cutoverDeployment: cutover, label: "station",
  }));
  assert.doesNotThrow(() => assertStableDeploymentAtCutover({
    deployments: [selected, { ...afterCutover, id: "invalid" }], selectedDeployment: selected, cutoverDeployment: cutover, label: "station",
  }));

  const superseding = deployment(uuid("b"), uuid("b"), "2026-08-28T10:30:00Z");
  assert.throws(() => assertStableDeploymentAtCutover({
    deployments: [superseding, selected], selectedDeployment: selected, cutoverDeployment: cutover, label: "station",
  }), /superseded before/);
  for (const event of interveningDeploymentEvents(ids.stationVersion)) {
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [selected, event], selectedDeployment: selected, cutoverDeployment: cutover, label: "station",
    }), /superseded before/);
  }

  assert.throws(() => assertStableDeploymentAtCutover({
    deployments: [afterCutover], selectedDeployment: afterCutover, cutoverDeployment: cutover, label: "station",
  }), /after the v3 cache cut-over/);
});

test("stable deployment chronology fails closed on malformed relevant records and same-time ambiguity", () => {
  const cutover = deployment(ids.cacheV3Deployment, ids.cacheV3Version, "2026-08-28T11:00:00Z");
  for (const [label, selectedId, selectedVersion] of [
    ["observations", ids.observationsDeployment, ids.observationsVersion],
    ["station", ids.stationDeployment, ids.stationVersion],
  ]) {
    const selected = deployment(selectedId, selectedVersion, "2026-08-28T10:00:00Z");
    const missingTime = deployment(uuid("a"), uuid("a"), undefined);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [selected], selectedDeployment: selected, cutoverDeployment: { ...cutover, created_on: "invalid" }, label,
    }), /cut-over deployment created_on is invalid/);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [selected, missingTime], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /created_on is required/);

    const malformedIdentity = { ...deployment(uuid("a"), uuid("a"), "2026-08-28T10:30:00Z"), id: "invalid" };
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [malformedIdentity, selected], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /identity is invalid in the relevant cut-over interval/);

    const sameTime = deployment(uuid("b"), uuid("b"), selected.created_on);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [sameTime, selected], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /chronology is ambiguous/);

    const atCutover = deployment(uuid("c"), uuid("c"), cutover.created_on);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [selected, atCutover], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /chronology is ambiguous at the v3 cache cut-over/);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [selected, null], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /deployment undefined created_on is required/);
    assert.throws(() => assertStableDeploymentAtCutover({
      deployments: [deployment(uuid("d"), uuid("d"), "2026-08-28T09:00:00Z")], selectedDeployment: selected, cutoverDeployment: cutover, label,
    }), /selected deployment is missing/);
  }
});

test("valid but superseded observations and station workflow runs fail rollback provenance", () => {
  const supersedingObservations = deployment(uuid("a"), uuid("a"), "2026-08-28T10:30:00Z");
  assert.throws(() => rollbackPayload({
    deployments: { observations: [...rollbackFixture().deployments.observations, supersedingObservations] },
  }), /observations selected deployment was superseded/);

  const supersedingStation = interveningDeploymentEvents(ids.stationVersion)[0];
  assert.throws(() => rollbackPayload({
    deployments: { station: [...rollbackFixture().deployments.station, supersedingStation] },
  }), /station selected deployment was superseded/);
});

test("rollback capture rejects placeholder UUIDs and unavailable historical cache identity", () => {
  const invalidRun = run("101", ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml", "unknown");
  assert.throws(() => rollbackPayload({ runs: { observations: invalidRun } }), /exactly one explicit Cloudflare version UUID/);
  assert.throws(() => rollbackPayload({ deployments: { cache: [] } }), /exact Cloudflare deployment identity is unavailable/);
});

test("current v3 cache cannot be selected as the accepted v2 baseline", () => {
  const wrongV2 = rollbackFixture().runs.cacheV2;
  wrongV2.log = `Current Version ID: ${ids.cacheV3Version}\nResolved STATION_HISTORY Service Binding target: uk-aq-station-history-test\nDeployed cache Worker: uk-aq-cache-test\nPersistent observation-history authority: v2\n`;
  assert.throws(
    () => rollbackPayload({
      runs: { cacheV2: wrongV2 },
    }),
    /v2 cache Cloudflare version detail does not match the workflow UUID/,
  );
});

test("authorised cut-over secret refresh becomes the exact pre-cutover rollback cache runtime", () => {
  const payload = rollbackPayload(secretRefreshOverrides());
  assert.equal(payload.cache_provenance.accepted_v2_cache_baseline.version_id, ids.cacheV2Version);
  assert.equal(payload.cache_provenance.pre_cutover_v2_cache_runtime.version_id, ids.cacheRefreshVersion);
  assert.equal(payload.cache_provenance.pre_cutover_v2_cache_runtime.deployment_id, ids.cacheRefreshDeployment);
  assert.equal(payload.cache_provenance.pre_cutover_v2_cache_runtime.workflow_run_id, "104");
  assert.equal(payload.cache_provenance.explicit_v3_cache_cutover.version_id, ids.cacheV3Version);
  assert.equal(payload.cache_provenance.transition_proof.kind, "cutover_workflow_secret_refresh");
  assert.equal(payload.restore_steps[3].command_or_workflow,
    `npx wrangler versions deploy ${ids.cacheRefreshVersion}@100% --name uk-aq-cache-test -y`);
  assert.equal(validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", payload), repositoryRoot,
  }).ok, true);
});

test("cache secret-refresh provenance remains fail-closed for unrelated or contradictory intervening deployments", () => {
  const random = secretRefreshOverrides();
  random.deployments.cache[1].annotations["workers/triggered_by"] = "deployment";
  random.versionDetails.cachePreCutover.annotations["workers/triggered_by"] = "version_upload";
  assert.throws(() => rollbackPayload(random), /deployment trigger is not secret/);

  const candidateBinding = secretRefreshOverrides();
  candidateBinding.versionDetails.cachePreCutover.resources.bindings
    .find(({ name }) => name === "STATION_HISTORY").service = "uk-aq-station-history-test-v3-candidate";
  assert.throws(() => rollbackPayload(candidateBinding), /not bound to the stable station-history Worker/);

  const changedCode = secretRefreshOverrides();
  changedCode.versionDetails.cachePreCutover.resources.script.etag = "e".repeat(64);
  assert.throws(() => rollbackPayload(changedCode), /does not retain the accepted v2 baseline code\/runtime identity/);

  const badSteps = secretRefreshOverrides();
  badSteps.runs.cacheV3.jobs[0].steps[0].conclusion = "failure";
  assert.throws(() => rollbackPayload(badSteps), /does not contain one successful Apply Worker secrets/);
});

test("cache chronology retains exact stable-v2 and candidate-v3 Service Binding proof", () => {
  assert.throws(() => rollbackPayload({
    versionDetails: {
      cacheV2: cacheVersionDetail(ids.cacheV2Version, 10, "2026-08-28T10:00:00Z", "uk-aq-station-history-test-v3-candidate"),
      cachePreCutover: cacheVersionDetail(ids.cacheV2Version, 10, "2026-08-28T10:00:00Z", "uk-aq-station-history-test-v3-candidate"),
    },
  }), /v2 cache version is not bound to the stable station-history Worker/);
  assert.throws(() => rollbackPayload({
    versionDetails: {
      cacheV3: cacheVersionDetail(ids.cacheV3Version, 11, "2026-08-28T11:00:00Z", "uk-aq-station-history-test"),
    },
  }), /v3 cache cut-over version is not bound to the station-history candidate/);
});

test("rollback validator reconstructs all four restore commands exactly", () => {
  const base = rollbackPayload();
  const mutations = [
    [0, (command) => command.replace("uk-aq-observs-history-r2-api-test", "uk-aq-observs-history-r2-api-test-v3-candidate")],
    [1, () => "npx wrangler deploy --name uk-aq-station-history-test"],
    [2, () => "gh variable set UK_AQ_R2_HISTORY_INDEX_VERSION --repo OTHER/repository --body v3"],
    [3, (command) => command.replace(ids.cacheV2Version, ids.cacheV3Version)],
  ];
  for (const [index, mutate] of mutations) {
    const payload = structuredClone(base);
    payload.restore_steps[index].command_or_workflow = mutate(payload.restore_steps[index].command_or_workflow);
    assert.throws(() => validateIndexV3OperatorEvidence({
      evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", payload), repositoryRoot,
    }), new RegExp(`restore command is invalid for ${payload.restore_steps[index].role}`));
  }

  const extraFlag = structuredClone(base);
  extraFlag.restore_steps[0].command_or_workflow += " --dry-run";
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", extraFlag), repositoryRoot,
  }), /restore command is invalid for restore_observations_worker/);

  const wrongKind = structuredClone(base);
  wrongKind.restore_steps[0].kind = "github_workflow";
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", wrongKind), repositoryRoot,
  }), /kind must be command/);

  const swapped = structuredClone(base);
  [swapped.restore_steps[0].command_or_workflow, swapped.restore_steps[1].command_or_workflow]
    = [swapped.restore_steps[1].command_or_workflow, swapped.restore_steps[0].command_or_workflow];
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", swapped), repositoryRoot,
  }), /restore command is invalid for restore_observations_worker/);
});

test("rollback validator pins every artifact role to its exact path and provenance commit", () => {
  const base = rollbackPayload();

  const wrongPath = structuredClone(base);
  wrongPath.artifacts[0] = gitBlobIdentity(
    repositoryRoot,
    "observations_deploy_workflow",
    ".github/workflows/uk_aq_station_history_deploy.yml",
    gitHead,
  );
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", wrongPath), repositoryRoot,
  }), /role\/path\/provenance commit mismatch: observations_deploy_workflow/);

  const wrongCommit = structuredClone(base);
  wrongCommit.artifacts[0] = gitBlobIdentity(
    repositoryRoot,
    "observations_deploy_workflow",
    ".github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml",
    parentGitHead,
  );
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", wrongCommit), repositoryRoot,
  }), /role\/path\/provenance commit mismatch: observations_deploy_workflow/);

  const distinctCacheCommits = rollbackPayload({
    runs: { cacheV3: { ...rollbackFixture().runs.cacheV3, head_sha: parentGitHead } },
  });
  const baselineArtifact = distinctCacheCommits.artifacts.find(({ role }) => role === "cache_deploy_workflow");
  const cutoverArtifact = distinctCacheCommits.artifacts.find(({ role }) => role === "cache_cutover_deploy_workflow");
  [baselineArtifact.git_commit_sha, cutoverArtifact.git_commit_sha]
    = [cutoverArtifact.git_commit_sha, baselineArtifact.git_commit_sha];
  [baselineArtifact.sha256, cutoverArtifact.sha256] = [cutoverArtifact.sha256, baselineArtifact.sha256];
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", distinctCacheCommits), repositoryRoot,
  }), /role\/path\/provenance commit mismatch: cache_deploy_workflow/);

  const duplicate = structuredClone(base);
  duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", duplicate), repositoryRoot,
  }), /artifact role is duplicated/);

  const extra = structuredClone(base);
  extra.artifacts.push({ ...structuredClone(extra.artifacts[0]), role: "unexpected_artifact" });
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", extra), repositoryRoot,
  }), /artifact role is unexpected/);
});

test("rollback validator requires Cloudflare UUID deployment identities for every component", () => {
  const base = rollbackPayload();
  for (const role of ["stable_observations_worker", "stable_station_worker", "cache_worker"]) {
    const payload = structuredClone(base);
    payload.components.find((component) => component.role === role).deployment.deployment_id = `invalid-${role}`;
    assert.throws(() => validateIndexV3OperatorEvidence({
      evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", payload), repositoryRoot,
    }), new RegExp(`rollback ${role} exact Cloudflare deployment identity is unavailable or invalid`));
  }
});

test("rollback validator rejects artifact drift and non-contiguous restoration", () => {
  const base = rollbackPayload();
  const drift = structuredClone(base);
  drift.artifacts[0].sha256 = "0".repeat(64);
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", drift), repositoryRoot,
  }), /does not match its pinned Git blob/);

  const order = structuredClone(base);
  order.restore_steps[2].order = 4;
  assert.throws(() => validateIndexV3OperatorEvidence({
    evidence: evidence("uk_aq_index_v3_v2_runtime_rollback_record", order), repositoryRoot,
  }), /order is not exact and contiguous/);
});

test("capture implementation exposes only read-only external operations", () => {
  assert.match(source, /method: "GET"/);
  assert.doesNotMatch(source, /method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(source, /run\("(?:npx|wrangler)"/);
  assert.doesNotMatch(source, /spawnSync\("(?:npx|wrangler)"/);
  assert.doesNotMatch(source, /\b(?:r2|d1)\b[^\n]*(?:put|delete|execute)/i);
  assert.doesNotMatch(source, /gh\(\["variable",\s*"set"/);
  assert.doesNotMatch(source, /gh\(\[[^\]]*(?:scheduler|maintenance)[^\]]*\]/i);
  assert.match(source, /gh\(\["variable", "get"/);
  assert.match(source, /gh\(\["api"/);
  assert.match(source, /gh\(\["run", "view"/);
});

test("rollback capture routes observations and domain Workers through their established Cloudflare accounts", () => {
  assert.deepEqual(cloudflareCaptureCredentials({
    CLOUDFLARE_ACCOUNT_ID: "generic-account",
    CLOUDFLARE_API_TOKEN: "generic-token",
    UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID: "r2-account",
    UK_AQ_R2_CLOUDFLARE_API_TOKEN: "r2-token",
    UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID: "domain-account",
    UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN: "domain-token",
  }), {
    observations: { accountId: "r2-account", apiToken: "r2-token" },
    domain: { accountId: "domain-account", apiToken: "domain-token" },
  });
});
