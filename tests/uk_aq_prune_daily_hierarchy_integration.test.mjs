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

test("Prune Daily delegates observation hierarchy and v3 indexes to the shared v3 writer", () => {
  const sharedImport = "uk_aq_r2_observations_global_finalizer.mjs";
  assert.match(integrityApply, new RegExp(sharedImport.replaceAll(".", "\\.")));
  assert.match(
    phaseB,
    /connectorPublisher\s*=\s*runOperationalPruneDailyObservationHistoryV3ConnectorPublication/,
  );
  assert.match(phaseB, /const connectorPublication = await connectorPublisher\(\{/);
  assert.match(
    phaseB,
    /runFinalizer\s*=\s*runOperationalPruneDailyObservationHistoryV3RunFinalization/,
  );
  assert.match(phaseB, /await runFinalizer\(\{/);
  assert.doesNotMatch(phaseB, new RegExp(sharedImport.replaceAll(".", "\\.")));
  assert.doesNotMatch(phaseB, /summary\.global_index_finalization/);
  assert.match(integrityApply, /runState\.global_index_finalization = await runCanonicalObservationsGlobalFinalizer\(/);
  assert.doesNotMatch(phaseB, /runCanonicalGlobalIndexFinalizer\(/);
  assert.doesNotMatch(integrityApply, /runCanonicalGlobalIndexFinalizer\(/);
});

test("Prune Daily no longer runs a second hierarchy finaliser from job.mjs", () => {
  assert.doesNotMatch(pruneJob, /finalizeR2HistoryV2ObservationsManifestHierarchy/);
  assert.doesNotMatch(pruneJob, /createPruneDailyHierarchyTaskRunAdapter/);
  assert.match(pruneJob, /executePruneDailyAdapter\(config\)/);
});
