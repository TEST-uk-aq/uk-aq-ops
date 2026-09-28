#!/usr/bin/env node
/** Fixed-v3 SOS-light canonical apply bridge. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  r2GetObject,
  r2HeadObject,
  r2DeleteObjects,
  r2ListAllObjects,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  putAndVerifyR2ObjectWithSha256,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import {
  requireObservationsGlobalOperationLockContext,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  validateFinalSosLightV3ProposalGraph,
  validateLocalSosLightV3Proposal,
} from "./lib/sos_light_v3_proposal_validation.mjs";
import {
  runPersistedSosLightV3Apply,
} from "./lib/sos_light_v3_apply_persistence.mjs";

function parseArgs(argv) {
  if (argv.length !== 3 || argv[0] !== "--run-state-json" || argv[2] !== "--write-r2") {
    throw new Error("Usage: uk_aq_apply_sos_light_v3_proposal.mjs --run-state-json PATH --write-r2");
  }
  return path.resolve(argv[1]);
}

function requireV3(env) {
  if (env.UK_AQ_R2_HISTORY_VERSION !== "v3" || env.UK_AQ_R2_HISTORY_INDEX_VERSION !== "v3") {
    throw new Error("SOS-light-v3 requires fixed v3 history and index authority");
  }
}

async function main() {
  requireV3(process.env);
  const runStatePath = parseArgs(process.argv.slice(2));
  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  if (runState.execution_path !== "sos_light") throw new Error("Fixed-v3 bridge accepts SOS-light proposals only");
  const lockRunId = String(runState?.observations_global_operation_lock?.run_id || "").trim();
  requireObservationsGlobalOperationLockContext({ env: process.env, expectedOwner: "integrity", expectedRunId: lockRunId });
  const config = resolveR2HistoryIndexConfig(process.env);
  if (!hasRequiredR2Config(config.r2)) throw new Error("SOS-light-v3 requires complete R2 configuration");
  const proposal = validateLocalSosLightV3Proposal(runState);
  await validateFinalSosLightV3ProposalGraph({ runState, proposal });
  return await runPersistedSosLightV3Apply({
    runStatePath,
    runState,
    proposal,
    r2: config.r2,
    adapters: {
      getObject: r2GetObject,
      putObject: r2PutObject,
      putAndVerifyParquet: async ({ r2, intent }) =>
        await putAndVerifyR2ObjectWithSha256({
          r2,
          intent,
          putObject: r2PutObject,
          headObject: r2HeadObject,
        }),
      listAllObjects: r2ListAllObjects,
      deleteObjects: r2DeleteObjects,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
