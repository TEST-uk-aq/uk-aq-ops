import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { observationsGlobalOperationLockContext } from "../../../workers/shared/uk_aq_r2_history_writer.mjs";
import { runCommandWithObservationsGlobalOperationLock } from "../../operations/uk_aq_with_observations_global_operation_lock.mjs";

export const BINDING_PUBLICATION_LOCK_OWNER = "observation_history_binding_publication";

// The existing child supervisor owns process-group termination on lock loss.
// Core publication and its dependent binding/range/root publication stay in one
// protected command; standalone hierarchy refresh also joins the same lock.
export async function delegateBindingPublicationIfNeeded(moduleUrl, argv = process.argv.slice(2), env = process.env) {
  const context = observationsGlobalOperationLockContext({ env, expectedOwner: BINDING_PUBLICATION_LOCK_OWNER });
  if (context.held && !context.valid) throw new Error("Invalid binding publication global lock context");
  if (context.valid) return null;
  return runCommandWithObservationsGlobalOperationLock({
    databaseUrl: env.SUPABASE_DB_URL || env.UK_AQ_INGEST_DATABASE_URL || env.DATABASE_URL,
    owner: BINDING_PUBLICATION_LOCK_OWNER,
    runId: randomUUID(), command: process.execPath,
    commandArgs: [fileURLToPath(moduleUrl), ...argv], env,
  });
}
