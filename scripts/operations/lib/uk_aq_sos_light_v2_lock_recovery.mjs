import fs from "node:fs";
import path from "node:path";

export const FIXED_V2_SOS_LIGHT_RECOVERY_PROFILE =
  "fixed-v2-sos-light-pre-mutation";
export const FIXED_V2_SOS_LIGHT_RECOVERY_CONTRACT =
  "uk_aq_sos_light_v2_pre_mutation_lock_recovery_v1";
export const FIXED_V2_SOS_LIGHT_RECOVERY_STATE_ENV =
  "UK_AQ_FIXED_V2_SOS_LIGHT_LOCK_RECOVERY_STATE_PATH";
export const FIXED_V2_SOS_LIGHT_RECOVERY_REENTRY_ENV =
  "UK_AQ_FIXED_V2_SOS_LIGHT_LOCK_RECOVERY_REENTRY";
export const FIXED_V2_SOS_LIGHT_RECOVERY_GENERATION_ENV =
  "UK_AQ_FIXED_V2_SOS_LIGHT_LOCK_RECOVERY_GENERATION";
export const FIXED_V2_SOS_LIGHT_RECOVERY_WINDOW_MS = 15 * 60 * 1000;

export function atomicWriteRecoveryState(statePath, state) {
  const resolved = path.resolve(String(statePath || ""));
  if (!String(statePath || "").trim()) {
    throw new Error("Fixed-v2 SOS-light recovery state path is required");
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const descriptor = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, body, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, resolved);
  const directory = fs.openSync(path.dirname(resolved), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export function readRecoveryState(statePath, { expectedRunId } = {}) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error("Fixed-v2 SOS-light recovery authority is unavailable or invalid", {
      cause: error,
    });
  }
  if (!state || typeof state !== "object" || Array.isArray(state)
      || state.contract_version !== FIXED_V2_SOS_LIGHT_RECOVERY_CONTRACT
      || state.profile !== FIXED_V2_SOS_LIGHT_RECOVERY_PROFILE
      || state.generation !== "v2"
      || state.authority_status !== "complete"
      || typeof state.logical_run !== "object"
      || !String(state.logical_run.run_compact || "").trim()
      || !String(state.logical_run.started_at_utc || "").trim()
      || !String(state.logical_run.lock_run_id || "").trim()
      || (expectedRunId && state.logical_run.lock_run_id !== String(expectedRunId))) {
    throw new Error("Fixed-v2 SOS-light recovery authority is incomplete or contradictory");
  }
  if (typeof state.r2_mutation_started !== "boolean") {
    throw new Error("Fixed-v2 SOS-light mutation-start authority is uncertain");
  }
  return state;
}

export function recordLockLoss({
  statePath,
  expectedRunId,
  error,
  nowIso = new Date().toISOString(),
}) {
  const state = readRecoveryState(statePath, { expectedRunId });
  const recovery = state.recovery ||= {};
  recovery.lock_loss_count = Number(recovery.lock_loss_count || 0) + 1;
  recovery.lock_lost_at_utc = nowIso;
  recovery.lock_loss_error = error instanceof Error ? error.message : String(error);
  recovery.lock_loss_error_class = error instanceof Error
    ? error.constructor?.name || "Error" : typeof error;
  recovery.lock_loss_error_code = String(error?.code || "") || null;
  recovery.mutation_classification = state.r2_mutation_started
    ? "post_mutation" : "pre_mutation";
  recovery.recovery_eligible = state.r2_mutation_started === false;
  recovery.deadline_utc = new Date(
    Date.parse(nowIso) + FIXED_V2_SOS_LIGHT_RECOVERY_WINDOW_MS,
  ).toISOString();
  recovery.reacquire_attempt_count = 0;
  recovery.outcome = state.r2_mutation_started
    ? "post_mutation_lock_loss" : "recovering";
  state.resume = state.r2_mutation_started ? "forbidden" : "unresolved";
  state.node_apply_launch_permitted = false;
  state.r2_mutation_possible = false;
  atomicWriteRecoveryState(statePath, state);
  if (state.r2_mutation_started) {
    const postMutation = new Error(
      "Fixed-v2 SOS-light lock loss occurred after the mutation boundary",
    );
    postMutation.code = "UK_AQ_SOS_LIGHT_V2_POST_MUTATION_LOCK_LOSS";
    throw postMutation;
  }
  return state;
}

export function recordReacquireAttempt({ statePath, expectedRunId, attemptCount }) {
  const state = readRecoveryState(statePath, { expectedRunId });
  state.recovery.reacquire_attempt_count = Number(attemptCount);
  atomicWriteRecoveryState(statePath, state);
  return state;
}

export function recordReacquired({
  statePath,
  expectedRunId,
  attemptCount,
  recoveryGeneration,
  lockIdentity,
  lockNonce,
  nowIso = new Date().toISOString(),
}) {
  const state = readRecoveryState(statePath, { expectedRunId });
  if (state.r2_mutation_started !== false) {
    throw new Error("Fixed-v2 SOS-light mutation status changed before reacquisition");
  }
  state.recovery.reacquire_attempt_count = Number(attemptCount);
  state.recovery.reacquired_at_utc = nowIso;
  state.recovery.recovery_generation = Number(recoveryGeneration);
  state.recovery.recovered_lock_session = {
    logical_identity: lockIdentity.logical_identity,
    class_id: lockIdentity.class_id,
    object_id: lockIdentity.object_id,
    nonce: lockNonce,
  };
  state.recovery.outcome = "revalidation_required";
  state.resume = "unresolved";
  state.node_apply_launch_permitted = false;
  state.r2_mutation_possible = false;
  atomicWriteRecoveryState(statePath, state);
  return state;
}

export function recordRecoveryOutcome({
  statePath,
  expectedRunId,
  outcome,
  error,
  nowIso = new Date().toISOString(),
}) {
  const state = readRecoveryState(statePath, { expectedRunId });
  state.recovery.outcome = outcome;
  state.recovery.finished_at_utc = nowIso;
  if (error) state.recovery.error = error instanceof Error ? error.message : String(error);
  state.resume = "forbidden";
  state.node_apply_launch_permitted = false;
  state.r2_mutation_possible = false;
  atomicWriteRecoveryState(statePath, state);
  return state;
}

export function markR2MutationStarted({
  statePath,
  expectedRunId,
  nowIso = new Date().toISOString(),
}) {
  const state = readRecoveryState(statePath, { expectedRunId });
  if (state.resume !== "permitted"
      || state.node_apply_launch_permitted !== true
      || state.r2_mutation_started !== false) {
    throw new Error(
      "Fixed-v2 SOS-light mutation boundary is missing, contradictory, or not authorised",
    );
  }
  state.r2_mutation_started = true;
  state.r2_mutation_started_at_utc = nowIso;
  state.automatic_lock_recovery_permitted = false;
  state.node_apply_launch_permitted = false;
  atomicWriteRecoveryState(statePath, state);
  return state;
}
