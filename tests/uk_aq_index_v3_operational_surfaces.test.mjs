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

function resolveStationHistoryService(normalService, override = "") {
  return spawnSync("bash", [bindingResolver, normalService, override], {
    encoding: "utf8",
  });
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

test("cache binding override is temporary, constrained and environment-specific", () => {
  const cases = [
    ["uk-aq-station-history-test", "", "uk-aq-station-history-test"],
    ["uk-aq-station-history-test", "uk-aq-station-history-test", "uk-aq-station-history-test"],
    ["uk-aq-station-history-test", "uk-aq-station-history-test-v3-candidate", "uk-aq-station-history-test-v3-candidate"],
    ["uk-aq-station-history-live", "uk-aq-station-history-live-v3-candidate", "uk-aq-station-history-live-v3-candidate"],
  ];
  for (const [normalService, override, expected] of cases) {
    const result = resolveStationHistoryService(normalService, override);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }

  for (const override of [
    "uk-aq-arbitrary-third-worker",
    "uk-aq-station-history-test-v3-candidate-v3-candidate",
  ]) {
    const result = resolveStationHistoryService("uk-aq-station-history-test", override);
    assert.notEqual(result.status, 0, `${override} should be rejected`);
  }

  assert.match(cacheWorkflow, /station_history_service_override:/);
  assert.match(cacheWorkflow, /STATION_HISTORY_SERVICE_OVERRIDE: \$\{\{ inputs\.station_history_service_override \|\| '' \}\}/);
  assert.match(cacheWorkflow, /bash \.\/resolve_station_history_service\.sh/);
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
