import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const phaseB = fs.readFileSync(
  new URL("../workers/uk_aq_prune_daily/phase_b_history_r2.mjs", import.meta.url),
  "utf8",
);
const integrityApply = fs.readFileSync(
  new URL("../scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs", import.meta.url),
  "utf8",
);
const pruneJob = fs.readFileSync(
  new URL("../workers/uk_aq_prune_daily/job.mjs", import.meta.url),
  "utf8",
);

test("Prune Daily delegates v2 hierarchy to the existing shared global finalizer", () => {
  const sharedImport = "uk_aq_r2_observations_global_finalizer.mjs";
  assert.ok(phaseB.includes(sharedImport));
  assert.ok(integrityApply.includes(sharedImport));
  assert.match(phaseB, /globalFinalizer = runCanonicalObservationsGlobalFinalizer/);
  assert.match(phaseB, /runCanonicalConnectorDayWriter\(/);
  assert.match(phaseB, /runCanonicalDayFinalizer\(/);
  assert.doesNotMatch(phaseB, /runOperationalPruneDailyObservationHistoryV3/);
  assert.doesNotMatch(phaseB, /runCanonicalGlobalIndexFinalizer\(/);
});

test("Prune Daily no longer runs a second hierarchy finaliser from job.mjs", () => {
  assert.doesNotMatch(pruneJob, /finalizeR2HistoryV2ObservationsManifestHierarchy/);
  assert.doesNotMatch(pruneJob, /createPruneDailyHierarchyTaskRunAdapter/);
  assert.match(pruneJob, /executePruneDailyAdapter\(config\)/);
});
