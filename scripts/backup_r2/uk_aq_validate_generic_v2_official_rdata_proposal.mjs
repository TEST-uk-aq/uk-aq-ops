#!/usr/bin/env node
/** Explicit mutation-free final admission CLI. Reads local authority; emits a plan. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasRequiredR2Config } from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { validateAndPlanGenericV2OfficialRdataProposal } from "./lib/generic_v2_official_rdata_proposal_validation.mjs";

export async function validateGenericV2OfficialRdataProposal({ runStatePath, env = process.env }) {
  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  if (runState.dry_run !== true) throw new Error("Validation-only CLI requires a dry-run proposal");
  const config = resolveR2HistoryIndexConfig({ ...env,
    UK_AQ_R2_HISTORY_VERSION: "v2", UK_AQ_R2_HISTORY_INDEX_VERSION: "v2" });
  if (!hasRequiredR2Config(config.r2)) throw new Error("Generic fixed-v2 requires complete R2 configuration");
  const plan = await validateAndPlanGenericV2OfficialRdataProposal({ runState, env });
  return { status: "validated", mutation_enabled: false,
    state_fingerprint_sha256: plan.state_fingerprint_sha256,
    operational_context_mode: plan.operational_context_mode,
    core_snapshot_identity_validation: plan.core_snapshot_identity_validation,
    final_proposal_graph_validation: plan.final_proposal_graph_validation,
    publication_schedule_validation: "succeeded", publication_schedule: plan.publication_schedule,
    deletion_schedule: plan.proposal.prefixes.map(({ prefix, entry }) => ({
      prefix, authority_outcome: entry.authority_outcome, authority_scope: entry.authority_scope,
    })),
    planned_deletions: plan.proposal.prefixes.length,
    planned_writes: plan.publication_schedule.total_positions,
    planned_post_put_verifications: plan.publication_schedule.total_positions,
    completed_writes: 0, completed_deletions: 0, deleted_objects: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--run-state-json") {
    process.stderr.write("Usage: uk_aq_validate_generic_v2_official_rdata_proposal.mjs --run-state-json PATH\n");
    process.exitCode = 1;
  } else {
    validateGenericV2OfficialRdataProposal({ runStatePath: path.resolve(args[1]) })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
