import { createHash } from "node:crypto";
import fs from "node:fs";

const files = {
  phaseB: "workers/uk_aq_prune_daily/phase_b_history_r2.mjs",
  integrity: "scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs",
  job: "workers/uk_aq_prune_daily/job.mjs",
  integrationTest: "tests/uk_aq_prune_daily_hierarchy_integration.test.mjs",
};

const expectedBlobSha = {
  [files.phaseB]: "d5024d7d996da4a9fe3b14747eb3de0cdfdb9183",
  [files.integrity]: "c8249c4c742734b64f795d20b1cf8407b758f41f",
  [files.job]: "6b5e1fb510e1dbfea004585e765fcb80390c3da3",
  [files.integrationTest]: "f79967ef52af02c2eeea2f282e585fc9a91d04a5",
};

function gitBlobSha(content) {
  const body = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(Buffer.from(`blob ${body.byteLength}\0`, "utf8"))
    .update(body)
    .digest("hex");
}

function readVerified(path) {
  const content = fs.readFileSync(path, "utf8");
  const actual = gitBlobSha(content);
  if (actual !== expectedBlobSha[path]) {
    throw new Error(`Refusing to patch changed file: ${path}; expected=${expectedBlobSha[path]}; actual=${actual}`);
  }
  return content;
}

function replaceOnce(content, oldValue, newValue, label) {
  const first = content.indexOf(oldValue);
  if (first < 0) throw new Error(`Patch anchor missing: ${label}`);
  if (content.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return `${content.slice(0, first)}${newValue}${content.slice(first + oldValue.length)}`;
}

let phaseB = readVerified(files.phaseB);
phaseB = replaceOnce(
  phaseB,
  `import {\n  mergeConnectorManifestReferences,\n  readParentManifestForBoundedRecovery,\n  runCanonicalDayFinalizer,\n  runCanonicalConnectorDayWriter,\n  runCanonicalGlobalIndexFinalizer,\n  withConnectorDayHistoryLock,\n} from "../shared/uk_aq_r2_history_writer.mjs";`,
  `import {\n  mergeConnectorManifestReferences,\n  readParentManifestForBoundedRecovery,\n  runCanonicalDayFinalizer,\n  runCanonicalConnectorDayWriter,\n  withConnectorDayHistoryLock,\n} from "../shared/uk_aq_r2_history_writer.mjs";\nimport {\n  runCanonicalObservationsGlobalFinalizer,\n} from "../shared/uk_aq_r2_observations_global_finalizer.mjs";`,
  "Prune Daily shared finaliser import",
);
phaseB = replaceOnce(
  phaseB,
  `    if (finalizedDays.length > 0 && summary.status !== "stopped_budget") {\n      summary.global_index_finalization = await runCanonicalGlobalIndexFinalizer({\n        client: controlClient,\n        diagnosticEnvironment: runtime.environment,\n        timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),\n        finalize: async () => await updateFinalizedHistoryIndexes({\n          runtime,\n          finalizedDays,\n          updateIndexesAdapter: updateR2HistoryIndexesTargeted,\n        }),\n      });\n    }`,
  `    if (finalizedDays.length > 0 && summary.status !== "stopped_budget") {\n      summary.global_index_finalization = await runCanonicalObservationsGlobalFinalizer({\n        client: controlClient,\n        diagnosticEnvironment: runtime.environment,\n        timeoutMs: Math.min(15_000, Math.max(1, remainingBudgetMs(runtime) ?? 15_000)),\n        r2: runtime.r2,\n        observationsPrefix: runtime.committed_prefix,\n        affectedDaysUtc: finalizedDays,\n        finalizeExistingIndexes: async () => await updateFinalizedHistoryIndexes({\n          runtime,\n          finalizedDays,\n          updateIndexesAdapter: updateR2HistoryIndexesTargeted,\n        }),\n      });\n    }`,
  "Prune Daily global finalisation block",
);
fs.writeFileSync(files.phaseB, phaseB, "utf8");

let integrity = readVerified(files.integrity);
integrity = replaceOnce(
  integrity,
  `import {\n  runCanonicalConnectorDayWriter,\n  runCanonicalDayFinalizer,\n  runCanonicalGlobalIndexFinalizer,\n  withHistoryWriterClient,\n  mergeConnectorManifestReferences,\n  readParentManifestForBoundedRecovery,\n} from "../../workers/shared/uk_aq_r2_history_writer.mjs";`,
  `import {\n  runCanonicalConnectorDayWriter,\n  runCanonicalDayFinalizer,\n  withHistoryWriterClient,\n  mergeConnectorManifestReferences,\n  readParentManifestForBoundedRecovery,\n} from "../../workers/shared/uk_aq_r2_history_writer.mjs";\nimport {\n  runCanonicalObservationsGlobalFinalizer,\n} from "../../workers/shared/uk_aq_r2_observations_global_finalizer.mjs";`,
  "Integrity shared finaliser import",
);
integrity = replaceOnce(
  integrity,
  `  const resolvedAdapters = {\n    deleteObjects: adapters.deleteObjects || r2DeleteObjects,\n    getObject: adapters.getObject || r2GetObject,\n    listAllObjects: adapters.listAllObjects || r2ListAllObjects,\n    putObject: adapters.putObject || r2PutObject,\n  };\n  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));`,
  `  const resolvedAdapters = {\n    deleteObjects: adapters.deleteObjects || r2DeleteObjects,\n    getObject: adapters.getObject || r2GetObject,\n    listAllObjects: adapters.listAllObjects || r2ListAllObjects,\n    putObject: adapters.putObject || r2PutObject,\n  };\n  const indexConfig = resolveR2HistoryIndexConfig(env);\n  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));`,
  "Integrity hierarchy configuration",
);
integrity = replaceOnce(
  integrity,
  `      await runCanonicalGlobalIndexFinalizer({\n          client: historyWriterClient,\n          diagnosticEnvironment: runState.environment,\n          diagnostics: runState.writer_locks,\n          finalize: async () => {\n            for (const operation of globalOperations) await executeOperation(operation);\n            if (affectedDays.length) {\n              runState.global_index_finalization = {\n                status: "succeeded",\n                mode: dedicatedSosProposal.dedicated ? "sos-light" : "canonical-preflight",\n                authority: "frozen_preflight_publication_schedule",\n                affected_days_utc: affectedDays,\n                planned_index_object_count: globalOperations.length,\n                live_generated_object_discovery_used: false,\n                publication_schedule_sha256: publicationSchedule.schedule_sha256,\n              };\n            }\n          },\n        });`,
  `      runState.global_index_finalization = await runCanonicalObservationsGlobalFinalizer({\n        client: historyWriterClient,\n        diagnosticEnvironment: runState.environment,\n        diagnostics: runState.writer_locks,\n        r2,\n        observationsPrefix: indexConfig.observations_prefix_v2,\n        affectedDaysUtc: affectedDays,\n        maxKeys: indexConfig.max_keys || 1000,\n        finalizeExistingIndexes: async () => {\n          for (const operation of globalOperations) await executeOperation(operation);\n          return {\n            status: "succeeded",\n            mode: dedicatedSosProposal.dedicated ? "sos-light" : "canonical-preflight",\n            authority: "frozen_preflight_publication_schedule",\n            planned_index_object_count: globalOperations.length,\n            live_generated_object_discovery_used: false,\n            publication_schedule_sha256: publicationSchedule.schedule_sha256,\n          };\n        },\n      });`,
  "Integrity global finalisation block",
);
fs.writeFileSync(files.integrity, integrity, "utf8");

let job = readVerified(files.job);
job = replaceOnce(
  job,
  `import { withDailyTaskRun } from "../shared/daily_task_health.mjs";\nimport { resolveR2HistoryIndexConfig } from "../shared/uk_aq_r2_history_index.mjs";\nimport {\n  finalizeR2HistoryV2ObservationsManifestHierarchy,\n} from "../shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs";\n`,
  "",
  "Prune Daily outer hierarchy imports",
);
const helperStart = job.indexOf("function exactPruneObservationAffectedDays(summary) {");
const helperEnd = job.indexOf("export async function writeReport(payload) {");
if (helperStart < 0 || helperEnd <= helperStart) {
  throw new Error("Prune Daily outer hierarchy helper block is unavailable");
}
job = `${job.slice(0, helperStart)}${job.slice(helperEnd)}`;
job = replaceOnce(
  job,
  `  writeReportAdapter = writeReport,\n  withDailyTaskRunAdapter = withDailyTaskRun,\n  resolveR2HistoryIndexConfigAdapter = resolveR2HistoryIndexConfig,\n  finalizerAdapter = finalizeR2HistoryV2ObservationsManifestHierarchy,\n  setExitCode = (code) => {`,
  `  writeReportAdapter = writeReport,\n  setExitCode = (code) => {`,
  "Prune Daily outer hierarchy adapter arguments",
);
job = replaceOnce(
  job,
  `    const config = buildRunConfigAdapter(url);\n    const hierarchyTaskRunAdapter = createPruneDailyHierarchyTaskRunAdapter({\n      env,\n      dryRun: config.dryRun === true,\n      withDailyTaskRunAdapter,\n      resolveR2HistoryIndexConfigAdapter,\n      finalizerAdapter,\n    });\n    const summary = await executePruneDailyAdapter(config, {\n      withDailyTaskRun: hierarchyTaskRunAdapter,\n    });`,
  `    const config = buildRunConfigAdapter(url);\n    const summary = await executePruneDailyAdapter(config);`,
  "Prune Daily direct execution",
);
fs.writeFileSync(files.job, job, "utf8");

const integrationTest = `import assert from "node:assert/strict";\nimport fs from "node:fs";\nimport test from "node:test";\n\nconst phaseB = fs.readFileSync(\n  new URL("../workers/uk_aq_prune_daily/phase_b_history_r2.mjs", import.meta.url),\n  "utf8",\n);\nconst integrityApply = fs.readFileSync(\n  new URL("../scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs", import.meta.url),\n  "utf8",\n);\nconst pruneJob = fs.readFileSync(\n  new URL("../workers/uk_aq_prune_daily/job.mjs", import.meta.url),\n  "utf8",\n);\n\ntest("Prune Daily and Integrity use the same observations global finaliser", () => {\n  const sharedImport = "uk_aq_r2_observations_global_finalizer.mjs";\n  assert.match(phaseB, new RegExp(sharedImport.replaceAll(".", "\\\\.")));\n  assert.match(integrityApply, new RegExp(sharedImport.replaceAll(".", "\\\\.")));\n  assert.match(phaseB, /summary\\.global_index_finalization = await runCanonicalObservationsGlobalFinalizer\\(/);\n  assert.match(integrityApply, /runState\\.global_index_finalization = await runCanonicalObservationsGlobalFinalizer\\(/);\n  assert.doesNotMatch(phaseB, /runCanonicalGlobalIndexFinalizer\\(/);\n  assert.doesNotMatch(integrityApply, /runCanonicalGlobalIndexFinalizer\\(/);\n});\n\ntest("Prune Daily no longer runs a second hierarchy finaliser from job.mjs", () => {\n  assert.doesNotMatch(pruneJob, /finalizeR2HistoryV2ObservationsManifestHierarchy/);\n  assert.doesNotMatch(pruneJob, /createPruneDailyHierarchyTaskRunAdapter/);\n  assert.match(pruneJob, /executePruneDailyAdapter\\(config\\)/);\n});\n`;
fs.writeFileSync(files.integrationTest, integrationTest, "utf8");

process.stdout.write("Applied shared observations global finaliser integration patch.\n");
