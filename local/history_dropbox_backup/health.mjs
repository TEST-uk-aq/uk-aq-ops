// Durable orchestration around the existing lifecycle client, never a second RPC client.
import { createDailyTaskHealthClient } from "../../workers/shared/daily_task_health.mjs";
import { buildHistoryBackupTaskSummary } from "../../scripts/backup_r2/build_history_backup_task_summary.mjs";
import { now, read, requireSafe, hash, privatePath } from "./config.mjs";
import path from "node:path";
import fs from "node:fs";
import { acceptReports } from "./reports.mjs";

export const TASK_KEY = "ops.r2_history_dropbox_backup_mbpro";
export function initialiseHealth(state, c, p) {
  if (state.health) return;
  requireSafe(!state.successful_completion, "legacy_completed_health_review");
  state.started_at ??= now();
  state.health = {
    version: 2, operation_id: state.operation_id, configuration_identity: c.fingerprint,
    input: { task_key: TASK_KEY, source_repo: "uk-aq-ops",
      source_worker: "local/history_dropbox_backup/supervisor.mjs", platform_run_id: state.operation_id,
      scheduled_for_date: state.started_at.slice(0, 10), started_at: state.started_at,
      summary: { execution_source: "macbook_pro_launchd", platform: "MBPro", environment: p.environment,
        one_off_operation_id: state.operation_id, backup_generation: "v3", binding_mode: "pack",
        launcher: { type: "launchd", job_label: p.label, domain: `gui/${process.getuid()}` } } },
    run_id: null, status: "pending", terminal: null, terminal_confirmed: false,
    recompute_confirmed: false, attempts: 0, attempts_since_review: 0,
    next_attempt_at: null, last_error: null,
  };
}
function summary(state) {
  return { ...state.health.input.summary, attempt_count: state.attempts,
    operation_started_at: state.started_at, backup_completed_at: state.completed_at,
    backup_complete: Boolean(state.successful_completion),
    accepted_report_identity: state.last_accepted_report?.report_identity || null };
}
export function queueFinished(state) {
  const h = state.health;
  requireSafe(h?.operation_id === state.operation_id && state.successful_completion
    && state.last_accepted_report?.operation_id === state.operation_id, "health_completion_identity");
  if (h.terminal) {
    requireSafe(h.terminal.kind === "finished", "health_already_failed"); return;
  }
  const reports = state.last_accepted_report.files;
  for (const file of Object.values(reports)) {
    privatePath(file.filename);
    requireSafe(hash(fs.readFileSync(file.filename)) === file.sha256, "health_report_identity");
  }
  const inventory = read(reports.inventory.filename), backup = read(reports.backup.filename);
  h.terminal = { kind: "finished", input: { ...h.input, finished_at: state.completed_at,
    summary: { ...buildHistoryBackupTaskSummary({ inventoryReport: inventory, backupReport: backup }),
      ...summary(state), operation_status: "completed",
      locked_exit_code: 0, publisher_succeeded: true, inventory_succeeded: true,
      required_domains_complete: true,
      observations: { source_root_hash: backup.observations.source_root_hash,
        processed_source_root_hash: backup.observations.processed_source_root_hash },
      timeseries_binding_packs: { source_root_hash: backup.timeseries_binding_packs.source_root_hash,
        processed_source_root_hash: backup.timeseries_binding_packs.processed_source_root_hash,
        verified: true, pack_root_sha256: backup.timeseries_binding_packs.pack_root_sha256 } } } };
  h.status = "pending"; h.attempts_since_review = 0; h.next_attempt_at = null;
}
export function queueFailed(state, category, at = now()) {
  const h = state.health;
  if (!h || h.terminal || state.successful_completion) return;
  h.terminal = { kind: "failed", input: { ...h.input, failed_at: at,
    error_message: category, error: { category },
    summary: { ...summary(state), operation_status: "failed", failure_category: category, failed_at: at } } };
  h.status = "pending"; h.attempts_since_review = 0; h.next_attempt_at = null;
}
export function reportingPending(state) {
  return Boolean(state?.health && state.health.status !== "confirmed"
    && (state.health.terminal || !state.health.run_id));
}
export function reviewHealth(state) {
  const h = state.health;
  requireSafe(h && h.status !== "confirmed", "health_already_confirmed");
  h.status = "pending"; h.attempts_since_review = 0; h.next_attempt_at = null;
}
export async function deliverHealth(state, c, save, options = {}) {
  const h = state.health;
  requireSafe(h?.version === 2 && h.operation_id === state.operation_id
    && h.configuration_identity === state.configuration_identity
    && h.input.task_key === TASK_KEY && h.input.platform_run_id === state.operation_id
    && h.input.started_at === state.started_at && h.input.scheduled_for_date === state.started_at.slice(0, 10)
    && (!h.run_id || h.run_id === state.operation_id)
    && c.fingerprint === state.configuration_identity,
    "health_operation_identity");
  if (h.terminal) requireSafe(h.terminal.input.task_key === TASK_KEY
    && h.terminal.input.started_at === h.input.started_at
    && h.terminal.input.platform_run_id === state.operation_id
    && h.terminal.input.scheduled_for_date === h.input.scheduled_for_date
    && h.terminal.input.source_repo === h.input.source_repo
    && h.terminal.input.source_worker === h.input.source_worker
    && h.terminal.input.summary.one_off_operation_id === state.operation_id
    && (h.terminal.kind !== "finished" || (h.terminal.input.finished_at === state.completed_at
      && h.terminal.input.summary.accepted_report_identity === state.last_accepted_report?.report_identity)),
  "health_terminal_identity");
  if (h.status === "confirmed" || (h.run_id && !h.terminal)) return true;
  if (h.status === "blocked") return false;
  const clock = options.now || Date.now;
  if (h.next_attempt_at && Date.parse(h.next_attempt_at) > clock()) return false;
  const client = options.client || createDailyTaskHealthClient({ env: {}, strict: true,
    disabled: false, recomputeDisabled: false, recomputeAfterTerminal: false,
    supabaseUrl: c.env.OBS_AQIDB_SUPABASE_URL, supabaseKey: c.env.OBS_AQIDB_SECRET_KEY,
    requestTimeoutMs: 15000, logHealth: () => {}, fetchImpl: options.fetchImpl });
  // At most Started, terminal update, and recompute. Each progress point is durable.
  for (let step = 0; step < 3; step += 1) {
    if (h.attempts_since_review >= c.max_attempts) {
      h.status = "blocked"; h.last_error = "health_retry_budget_exhausted"; save(); return false;
    }
    h.attempts += 1; h.attempts_since_review += 1; save(); // A crash consumes its request budget.
    try {
      if (!h.run_id) {
        const id = await client.dailyTaskStarted({ ...h.input, run_id: h.operation_id });
        requireSafe(id === h.operation_id, "health_response_invalid");
        h.run_id = id;
      } else if (h.terminal && !h.terminal_confirmed) {
        if (h.terminal.kind === "finished") await client.dailyTaskFinished(h.run_id, h.terminal.input);
        else await client.dailyTaskFailed(h.run_id, new Error(h.terminal.input.error_message), h.terminal.input);
        h.terminal_confirmed = true;
      } else if (h.terminal && !h.recompute_confirmed) {
        await client.recomputeDailyTaskStatus(h.input.scheduled_for_date);
        h.recompute_confirmed = true;
      }
      h.status = h.recompute_confirmed ? "confirmed" : h.terminal ? "pending" : "started";
      h.attempts_since_review = 0; h.next_attempt_at = null; h.last_error = null; save();
      if (h.status === "confirmed" || !h.terminal) return true;
    } catch (error) {
      const status = error.httpStatus;
      const transient = !error.category && (status === undefined || status === 408 || status === 429 || status >= 500);
      h.status = transient && h.attempts_since_review < c.max_attempts ? "pending" : "blocked";
      h.last_error = error.category || (transient ? "health_delivery_unconfirmed" : "health_rpc_rejected");
      h.next_attempt_at = h.status === "pending"
        ? new Date(clock() + Math.min(3600, 300 * 2 ** Math.min(4, h.attempts_since_review - 1)) * 1000).toISOString() : null;
      save(); return false;
    }
  }
  return h.status === "confirmed";
}

// This boundary is shared by supervision and the focused crash-recovery check.
export async function afterAcceptedBackup(state, c, save, options = {}) {
  requireSafe(state.successful_completion?.operation_id === state.operation_id, "backup_not_accepted");
  queueFinished(state); save();
  return deliverHealth(state, c, save, options);
}

export async function executeBackupOrReport(state, c, save, { runBackup, healthOptions = {} }) {
  if (!state.successful_completion) await runBackup();
  return afterAcceptedBackup(state, c, save, healthOptions);
}

export function restoreAcceptedBackup(state, c) {
  if (state.successful_completion || !state.current_invocation) return false;
  const invocation = state.current_invocation;
  const accepted = read(path.join(invocation.reports, "accepted.json"));
  if (!accepted) return false;
  const exit = read(path.join(invocation.reports, "locked-exit.json"));
  const receipt = accepted.locked_receipt?.observations_global_operation_lock;
  requireSafe(accepted.operation_id === state.operation_id && accepted.run_id === invocation.run_id
    && accepted.configuration_identity === c.fingerprint && invocation.operation_id === state.operation_id
    && exit?.exit_code === 0 && exit.run_id === invocation.run_id && accepted.locked_exit_code === 0
    && accepted.locked_receipt?.ok === true && accepted.locked_receipt.generation === "v3"
    && receipt?.owner === "r2_history_dropbox_backup" && receipt.run_id === invocation.run_id
    && receipt.acquired === true && receipt.outcome === "held"
    && Number.isFinite(Date.parse(accepted.accepted_at)), "accepted_recovery_invalid");
  const verified = acceptReports(invocation.reports, c, invocation);
  requireSafe(verified.report_identity === accepted.report_identity, "accepted_recovery_identity");
  state.last_accepted_report = verified; state.completed_at = accepted.accepted_at;
  state.status = "completed"; state.last_failure_category = null;
  state.successful_completion = { operation_id: state.operation_id, configuration_identity: c.fingerprint,
    report_identity: accepted.report_identity, completed_at: accepted.accepted_at };
  return true;
}
