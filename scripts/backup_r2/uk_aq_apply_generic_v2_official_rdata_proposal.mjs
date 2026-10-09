#!/usr/bin/env node
/** Generic fixed-v2 WAQN/SAQN selected-scope canonical APPLY bridge. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hasRequiredR2Config } from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  requireObservationsGlobalOperationLockContext,
  withHistoryWriterClient,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import { applyValidatedProposal } from "./uk_aq_apply_integrity_proposal.mjs";
import {
  requireGenericV2CoordinatorFreeze,
  requireRetainedV2MaintenanceContext,
  validateFinalGenericV2ProposalGraph,
  validateLocalGenericV2Proposal,
} from "./lib/generic_v2_official_rdata_proposal_validation.mjs";

function parseArgs(argv) {
  if (argv.length !== 3 || argv[0] !== "--run-state-json" || argv[2] !== "--write-r2") {
    throw new Error("Usage: uk_aq_apply_generic_v2_official_rdata_proposal.mjs --run-state-json PATH --write-r2");
  }
  return path.resolve(argv[1]);
}

export async function applyValidatedGenericV2OfficialRdataProposal({
  runStatePath,
  r2,
  adapters = {},
  env = process.env,
}) {
  const operationEnv = {
    ...env,
    UK_AQ_R2_HISTORY_VERSION: "v2",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v2",
  };
  const coordinatorState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  if (coordinatorState.execution_path !== "generic_integrity"
      || !["waqn", "saqn"].includes(coordinatorState.official_rdata_source_adapter)) {
    throw new Error("Generic fixed-v2 bridge accepts WAQN/SAQN generic_integrity proposals only");
  }
  const lockRunId = String(
    coordinatorState?.observations_global_operation_lock?.run_id || "",
  ).trim();
  requireObservationsGlobalOperationLockContext({
    env: operationEnv,
    expectedOwner: "integrity",
    expectedRunId: lockRunId,
  });
  if (!hasRequiredR2Config(r2)) {
    throw new Error("Generic fixed-v2 requires complete R2 configuration");
  }
  return await applyValidatedProposal({
    runStatePath,
    r2,
    adapters,
    env: operationEnv,
    generation: "v2",
    expectedExecutionPath: "generic_integrity",
    generationEligibilityValidator: ({ runState }) =>
      requireRetainedV2MaintenanceContext(runState, operationEnv),
    coordinatorFreezeValidator: (runState) =>
      requireGenericV2CoordinatorFreeze(runState, operationEnv),
    localProposalValidator: (runState) =>
      validateLocalGenericV2Proposal(runState, operationEnv),
    finalProposalGraphValidator: validateFinalGenericV2ProposalGraph,
  });
}

async function main() {
  const runStatePath = parseArgs(process.argv.slice(2));
  const config = resolveR2HistoryIndexConfig(process.env);
  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Generic fixed-v2 requires complete R2 configuration");
  }
  return await withHistoryWriterClient(
    process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
    async (historyWriterClient) => await applyValidatedGenericV2OfficialRdataProposal({
      runStatePath,
      r2: config.r2,
      env: process.env,
      adapters: { historyWriterClient },
    }),
    { applicationName: "uk-aq-integrity-generic-v2-official-rdata-writer" },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
