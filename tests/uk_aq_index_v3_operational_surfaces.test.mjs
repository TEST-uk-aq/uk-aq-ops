import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertV3Candidate } from "../workers/uk_aq_station_history_v3_candidate/entry.mjs";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const preflight = read("scripts/index_v3_migration/index_v3_preflight.sh");
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
  assert.doesNotMatch(stationWrangler, /^name\s*=/m);
  assert.doesNotMatch(observationsWrangler, /^name\s*=/m);
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
