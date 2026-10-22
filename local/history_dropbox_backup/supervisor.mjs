#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runChildWhileLockHeld } from "../../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs";
import { active, atomic, childEnvironment, hash, load, locations, mkdir, mutex, now,
  prepare, read, remoteConfiguration, repo, requireSafe } from "./config.mjs";
import { acceptReports } from "./reports.mjs";
import { initialiseHealth, deliverHealth, queueFailed, executeBackupOrReport,
  restoreAcceptedBackup } from "./health.mjs";

process.umask(0o077);
const args = process.argv.slice(2);
requireSafe(args.length === 4 && args[0] === "--environment" && args[2] === "--config");
const p = locations(args[1], args[3]);
let state, release;
let attemptDirectory, logDirectory, invocation, heartbeat;
let stopped = false;
let category = "unexpected_failure";
let secrets = [];
let diagnosticTail = "";
let lockedReceipt = null;
const streamsDone = [];
function safe(line) {
  let result = line;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return result.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:access_token|refresh_token|client_secret|secret_access_key|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
}
function note(message) {
  const line = `${now()} ${message}\n`;
  process.stdout.write(line);
  if (logDirectory) {
    try { fs.appendFileSync(path.join(logDirectory, "supervisor.log"), line, { mode: 0o600 }); }
    catch { process.stderr.write("Local supervisor log write failed\n"); }
  }
}
function publish() { atomic(p.active, state); }
function requestedStop() { return read(p.stop)?.operation_id === state?.operation_id; }
function observe(line) {
  // Only the final locked-runner receipt can prove that it actually held the expected lock.
  try {
    const value = JSON.parse(line);
    if (value.ok === true && value.observations_global_operation_lock) lockedReceipt = value;
  } catch { /* Most canonical output is ordinary progress or pretty-printed JSON. */ }
  diagnosticTail = (diagnosticTail + "\n" + safe(line)).slice(-65536);
  if (/lock_lost|lock session lost|LOCK_LOST/i.test(line)) category = "lock_lost";
  else if (category !== "lock_lost" && /invalid_grant|invalid_client|expired_access_token|invalid_access_token|authentication failed|password authentication|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|\b401\b|\b403\b/i.test(line)) category = "authentication";
}
function capture(stream, filename, output) {
  // Bound line buffering. Suppress oversized lines rather than expose a split secret.
  let pending = "", dropping = false;
  stream.setEncoding("utf8");
  const emit = (line) => {
    observe(line);
    const text = safe(line) + "\n";
    try { fs.appendFileSync(filename, text, { mode: 0o600 }); }
    catch { process.stderr.write("Local attempt log write failed\n"); }
    output.write(text);
  };
  stream.on("data", (chunk) => {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!dropping) pending += part;
      if (pending.length > 65536) { pending = ""; dropping = true; }
      if (part.endsWith("\n")) {
        emit(dropping ? "[oversized diagnostic line suppressed]" : pending.trimEnd());
        pending = ""; dropping = false;
      }
    }
  });
  stream.on("end", () => { if (dropping) emit("[oversized diagnostic line suppressed]"); else if (pending) emit(pending); });
  streamsDone.push(new Promise((resolve) => { stream.once("close", resolve); }));
}

async function runBackup(c) {
  const started = now();
  const attemptId = `${started.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}_${randomUUID()}`;
  attemptDirectory = path.join(p.reports, state.operation_id, attemptId);
  logDirectory = path.join(p.logs, state.operation_id, attemptId);
  mkdir(path.dirname(attemptDirectory)); fs.mkdirSync(attemptDirectory, { mode: 0o700 });
  mkdir(path.dirname(logDirectory)); fs.mkdirSync(logDirectory, { mode: 0o700 });
  state.attempts += 1; state.attempts_since_review += 1;
  state.started_at ??= started;
  state.status = "running"; state.next_attempt_at = null;
  invocation = { operation_id: state.operation_id, run_id: `r2-history-dropbox-backup:${state.operation_id}:${state.attempts}:${randomUUID()}`,
    attempt: state.attempts, started_at: started, environment: p.environment,
    configuration_identity: c.fingerprint, reports: attemptDirectory, logs: logDirectory, pid: process.pid };
  state.current_invocation = invocation; publish();
  atomic(path.join(attemptDirectory, "invocation.json"), invocation);
  // Fail before network mutation if persistent logs cannot be opened.
  for (const filename of ["stdout.log", "stderr.log", "supervisor.log"]) {
    fs.closeSync(fs.openSync(path.join(logDirectory, filename), "wx", 0o600));
  }
  const env = childEnvironment(c, p);
  // Guard the actual local rclone remotes before any network/lock/backup activity.
  secrets = remoteConfiguration(c, env);
  note(`Running: operation=${state.operation_id} attempt=${state.attempts} reports=${attemptDirectory} logs=${logDirectory}`);
  const startedMs = Date.now();
  heartbeat = setInterval(() => {
    try { note(`Backup active elapsed=${Math.floor((Date.now() - startedMs) / 1000)}s ETA=unknown`); }
    catch { process.stderr.write("Local progress log write failed\n"); }
  }, 15000);
  const onStop = () => { stopped = true; };
  process.on("SIGTERM", onStop); process.on("SIGINT", onStop);
  const commandArgs = ["scripts/operations/uk_aq_with_observations_global_operation_lock.mjs",
    "--owner", "r2_history_dropbox_backup", "--run-id", invocation.run_id,
    "--timeout-ms", "60000", "--heartbeat-ms", "5000", "--", process.execPath,
    "scripts/backup_r2/uk_aq_run_locked_history_backup.mjs", "--generation", "v3",
    "--source-root", c.source, "--dest-root", c.destination,
    "--timeseries-binding-backup-mode", "pack", "--allow-experimental-pack-only",
    "--observation-parquet-copy-mode", "full", "--max-days-per-run", "0",
    "--checkpoint-batch-units", c.env.UK_AQ_R2_HISTORY_CHECKPOINT_BATCH_UNITS,
    "--checkpoint-flush-seconds", c.env.UK_AQ_R2_HISTORY_CHECKPOINT_FLUSH_SECONDS,
    "--pack-publisher-report-out", path.join(attemptDirectory, "publisher.json"),
    "--inventory-report-out", path.join(attemptDirectory, "inventory.json"),
    "--backup-report-out", path.join(attemptDirectory, "backup.json")];
  // Reuse the canonical liveness-pipe process-group supervisor around the
  // coordinator too: SIGKILL of this local parent cannot orphan the lock holder.
  const exitCode = await runChildWhileLockHeld({ command: process.execPath, commandArgs, env,
    spawnProcess(command, argv, options) {
      const child = spawn(command, argv, { ...options, cwd: repo,
        stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"] });
      capture(child.stdout, path.join(logDirectory, "stdout.log"), process.stdout);
      capture(child.stderr, path.join(logDirectory, "stderr.log"), process.stderr);
      return child;
    } });
  await Promise.all(streamsDone);
  process.off("SIGTERM", onStop); process.off("SIGINT", onStop);
  clearInterval(heartbeat); heartbeat = undefined;
  atomic(path.join(attemptDirectory, "locked-exit.json"), { ...invocation, completed_at: now(), exit_code: exitCode });
  if (requestedStop()) requireSafe(false, "operator_stopped");
  if (stopped) requireSafe(false, "interrupted");
  requireSafe(exitCode === 0, category === "unexpected_failure" ? "command_failed" : category);
  const receipt = lockedReceipt?.observations_global_operation_lock;
  requireSafe(lockedReceipt?.ok === true && lockedReceipt.generation === "v3"
    && receipt?.owner === "r2_history_dropbox_backup" && receipt.run_id === invocation.run_id
    && receipt.acquired === true && receipt.outcome === "held", "locked_receipt_invalid");
  const accepted = acceptReports(attemptDirectory, c, invocation);
  const acceptedAt = now();
  atomic(path.join(attemptDirectory, "accepted.json"), { ...accepted, locked_receipt: lockedReceipt,
    configuration_identity: c.fingerprint, accepted_at: acceptedAt, locked_exit_code: exitCode });
  state.last_accepted_report = accepted;
  state.completed_at = acceptedAt; state.status = "completed"; state.last_failure_category = null;
  state.successful_completion = { operation_id: state.operation_id, configuration_identity: c.fingerprint,
    report_identity: accepted.report_identity, completed_at: state.completed_at };
  publish();

}
function healthExit(confirmed) {
  if (confirmed) return 0;
  return !state.health || state.health.status === "blocked" ? 0 : 1;
}
async function settleAccepted(c) {
  try {
    return await executeBackupOrReport(state, c, publish, { runBackup: () => runBackup(c) });
  } catch (error) {
    if (state.health) {
      state.health.status = "blocked";
      state.health.last_error = error.category || "health_evidence_requires_review";
      state.health.next_attempt_at = null; publish();
    }
    atomic(p.block, { category: error.category || "health_evidence_requires_review", at: now() });
    return false;
  }
}
function actualLaunchdJob() {
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${p.label}`], {
    encoding: "utf8", timeout: 5000 });
  requireSafe(result.status === 0 && new RegExp(`\\bpid = ${process.pid}\\b`).test(result.stdout), "launchd_provenance");
}
try {
  requireSafe(process.platform === "darwin", "macos_required");
  prepare(p); release = mutex(p); state = active(p);
  if (!state) { note("Ready: explicit start required"); process.exitCode = 0; }
  else {
    requireSafe(state.status === "completed" || !read(p.block), "supervision_review");
    const c = load(p);
    // Node reads extra trust only at startup; a stale plist must not proceed.
    requireSafe(process.env.NODE_EXTRA_CA_CERTS === c.postgres_ca_file, "postgres_ca_startup");
    requireSafe(c.fingerprint === state.configuration_identity, "configuration_changed");
    requireSafe(p.environment !== "LIVE" || c.live_activation_authorized === true, "live_inactive");
    // A crash after accepted.json but before active.json must not redo completed remote work.
    restoreAcceptedBackup(state, c); publish();
    if (state.successful_completion) {
      const confirmed = await settleAccepted(c);
      note(`Backup completed; task health ${confirmed ? "confirmed" : state.health?.status || "requires_review"}: operation=${state.operation_id}`);
      process.exitCode = healthExit(confirmed);
    } else if (state.status === "blocked" || requestedStop() || state.health?.terminal) {
      state.status = "blocked";
      state.last_failure_category ||= requestedStop() ? "operator_stopped" : "terminal_failure";
      queueFailed(state, state.last_failure_category); publish();
      const confirmed = state.health ? await deliverHealth(state, c, publish) : true;
      note(`Backup blocked: operation=${state.operation_id}; health=${state.health?.status || "not_started"}`);
      process.exitCode = state.health ? healthExit(confirmed) : 0;
    } else {
      actualLaunchdJob();
      initialiseHealth(state, c, p); publish();
      if (!await deliverHealth(state, c, publish)) {
        state.status = state.health.status === "blocked" ? "blocked" : "retrying";
        state.last_failure_category = "health_reporting"; publish();
        note(`Started health reporting ${state.health.status}: operation=${state.operation_id}`);
        process.exitCode = healthExit(false);
      } else {
        if (state.status === "running") {
          state.status = "retrying"; state.last_failure_category = "interrupted";
          state.next_attempt_at = new Date(Date.now() + 300000).toISOString(); publish();
        }
        requireSafe(state.attempts_since_review < c.max_attempts, "retry_budget_exhausted");
        if (state.next_attempt_at && Date.parse(state.next_attempt_at) > Date.now()) {
          note(`Retrying: operation=${state.operation_id}; next=${state.next_attempt_at}`);
          process.exitCode = 1;
        } else {
          const confirmed = await executeBackupOrReport(state, c, publish, { runBackup: () => runBackup(c) });
          note(`Backup completed; task health ${confirmed ? "confirmed" : state.health.status}: operation=${state.operation_id}`);
          process.exitCode = healthExit(confirmed);
        }
      }
    }
  }
} catch (error) {
  clearInterval(heartbeat); await Promise.all(streamsDone);
  category = error.category || (stopped ? "interrupted" : category);
  if (category === "already_running") {
    process.stderr.write("Existing local supervisor owns this installation\n"); process.exitCode = 0;
  } else if (state && release) {
    let c;
    try {
      const configured = load(p);
      requireSafe(process.env.NODE_EXTRA_CA_CERTS === configured.postgres_ca_file, "postgres_ca_startup");
      c = configured; restoreAcceptedBackup(state, c);
    } catch { /* Preserve any already accepted evidence; do not report with stale CA trust. */ }
    if (state.successful_completion) {
      // Completion is immutable even if reporting or local IO failed later.
      if (c && state.health) {
        const confirmed = await settleAccepted(c);
        process.exitCode = healthExit(confirmed);
      } else {
        atomic(p.block, { category, at: now(), operation_id: state.operation_id });
        note(`Backup completed; health requires review: operation=${state.operation_id} error=${category}`);
        process.exitCode = 0;
      }
    } else {
      const permanent = !["unexpected_failure", "command_failed", "interrupted"].includes(category);
      state.last_failure_category = category;
      state.status = permanent || state.attempts_since_review >= (c?.max_attempts || 1) ? "blocked" : "retrying";
      state.next_attempt_at = state.status === "retrying"
        ? new Date(Date.now() + Math.min(3600, 300 * 2 ** Math.min(4, state.attempts_since_review - 1)) * 1000).toISOString() : null;
      if (state.status === "blocked") queueFailed(state, category);
      publish();
      if (attemptDirectory) atomic(path.join(attemptDirectory, "outcome.json"), {
        ...invocation, completed_at: now(), status: state.status, failure_category: category,
        diagnostic_tail_sha256: hash(diagnosticTail) });
      note(`${state.status}: operation=${state.operation_id} error=${category}`);
      if (state.status === "blocked" && c && state.health) {
        process.exitCode = healthExit(await deliverHealth(state, c, publish));
      } else process.exitCode = state.status === "retrying" ? 1 : 0;
    }
  } else {
    try { atomic(p.block, { category, at: now() }); } catch { /* Status validates local evidence too. */ }
    process.stderr.write(`Blocked: ${category}; inspect protected configuration/state\n`); process.exitCode = 0;
  }
} finally { if (release) release(); }
