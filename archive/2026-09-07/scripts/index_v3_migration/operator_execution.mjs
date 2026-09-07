#!/usr/bin/env node
// Diagnostic execution support. Never migration/checkpoint/runtime authority.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}
const safeWrite = text => { try { process.stderr.write(text); } catch { /* diagnostic only */ } };
let heartbeatWorker;
let nextId = 0;
const active = new Map();
const phaseMetadata = new Map();
const progressDirectory = process.env.UK_AQ_OPERATOR_RUN_DIR ? path.join(process.env.UK_AQ_OPERATOR_RUN_DIR, 'active_phases') : null;
function updatePhaseMarker() {
  if (!progressDirectory) return;
  try {
    fs.mkdirSync(progressDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(progressDirectory, `${process.pid}.json`);
    const latest = [...phaseMetadata.values()].at(-1);
    if (!latest) { if (fs.existsSync(target)) fs.unlinkSync(target); return; }
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ ...latest, pid: process.pid }), { mode: 0o600 });
    fs.renameSync(`${target}.tmp`, target);
  } catch { /* diagnostic only */ }
}
function worker() {
  if (!heartbeatWorker) {
    heartbeatWorker = new Worker(new URL(import.meta.url), { workerData: { heartbeat: true } });
    heartbeatWorker.on('error', () => safeWrite('WARN: operator heartbeat worker failed\n'));
    heartbeatWorker.unref();
  }
  return heartbeatWorker;
}
function progressLine(label, state, started, status) {
  const elapsed = Date.now() - started;
  const [completed, total, bytes, totalBytes] = state;
  const counter = total >= 0 ? ` objects=${completed}/${total}` : '';
  const byteCounter = totalBytes > 0 ? ` bytes=${bytes}/${totalBytes}` : '';
  // Object counts alone are not a defensible cost model for heterogeneous files.
  const eta = totalBytes > 0
    ? bytes > 0 && elapsed >= 15000
      ? `ETA~${formatElapsed((totalBytes - bytes) * elapsed / bytes)}` : 'ETA=calculating'
    : 'ETA=unknown';
  return `${label}: ${status} elapsed=${formatElapsed(elapsed)}${counter}${byteCounter} ${eta}\n`;
}
export function createOperatorProgress({ label, total, totalBytes = 0, enabled = true } = {}) {
  const noop = Object.freeze({ report() {}, finish() {} });
  if (!enabled) return noop;
  try {
    const id = ++nextId;
    const state = new Float64Array(new SharedArrayBuffer(5 * 8));
    state[1] = Number.isInteger(total) && total >= 0 ? total : -1;
    state[3] = totalBytes;
    const started = Date.now();
    const finish = (status = 'complete') => {
      if (state[4]) return;
      state[4] = 1;
      active.delete(id);
      phaseMetadata.delete(id); updatePhaseMarker();
      safeWrite(progressLine(label, state, started, status));
    };
    active.set(id, finish);
    phaseMetadata.set(id, { started, id }); updatePhaseMarker();
    safeWrite(progressLine(label, state, started, 'start'));
    worker().postMessage({ id, label, state: state.buffer, started });
    return Object.freeze({
      report(completed, { bytes } = {}) {
        try {
          state[0] = Number(completed) || 0;
          if (Number.isFinite(bytes)) state[2] = bytes;
          if (state[1] >= 0 && state[0] >= state[1]) finish();
        } catch { /* counters never affect execution */ }
      },
      finish,
    });
  } catch { return noop; }
}
export function finishOperatorProgress(status = 'complete') {
  for (const finish of [...active.values()].reverse()) finish(status);
}
export async function withOperatorPhase(label, action, options = {}) {
  const before = new Set(active.keys());
  const progress = createOperatorProgress({ label, ...options });
  try {
    const result = await action(progress);
    for (const [id, finish] of [...active].reverse()) if (!before.has(id)) finish(result?.ok === false ? 'failed' : 'complete');
    return result;
  } catch (error) {
    for (const [id, finish] of [...active].reverse()) if (!before.has(id)) finish('failed');
    throw error;
  } finally { progress.finish(); }
}

// A separate thread keeps the wall-clock heartbeat alive during synchronous Git,
// replay/hashing and CPU-bound planning. Only the innermost active phase reports.
if (!isMainThread && workerData?.heartbeat) {
  const phases = new Map();
  parentPort.on('message', entry => phases.set(entry.id, { ...entry, state: new Float64Array(entry.state), last: entry.started }));
  setInterval(() => {
    for (const [id, phase] of phases) if (phase.state[4]) phases.delete(id);
    const phase = [...phases.values()].at(-1);
    if (phase && Date.now() - phase.last >= 15000) {
      // An enclosing shell phase and an instrumented child share the same run.
      // Only the most recently entered live process phase owns its heartbeat.
      let newer = false;
      if (progressDirectory) try {
        for (const name of fs.readdirSync(progressDirectory).filter(name => name.endsWith('.json'))) {
          const other = JSON.parse(fs.readFileSync(path.join(progressDirectory, name)));
          if (other.pid === process.pid || other.started <= phase.started) continue;
          try { process.kill(other.pid, 0); newer = true; } catch { /* exited child */ }
        }
      } catch { /* keep local heartbeat if diagnostics are unavailable */ }
      if (newer) return;
      try { fs.writeSync(2, progressLine(phase.label, phase.state, phase.started, 'active')); } catch { /* diagnostic only */ }
      phase.last = Date.now();
    }
  }, 250);
}

// Redact known secret-bearing environment values and credential-shaped output.
// Buffer lines (bounded) so a value split across child chunks is still redacted.
export function redactOperatorText(text, env = process.env) {
  let output = String(text);
  for (const [name, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|AUTH|ACCESS_KEY|DATABASE_URL|DB_URL|PRIVATE_KEY/i.test(name) && value) {
      output = output.split(value).join('[REDACTED]');
    }
  }
  return output.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, '$1[REDACTED]')
    .replace(/^(?:(?:MIGRATE|RESUME|ROLLBACK) |AUTHORISE_)[^\n]+/gm, '[REDACTED authorisation phrase]')
    .replace(/(Required exact UK_AQ_INDEX_V3_[A-Z_]+:\n)[^\n]+/g, '$1[REDACTED]');
}
export async function runOperatorCommand(command, args, { cwd, env = process.env, label = 'Child command', emit = true, sink, phase = true, onSpawn } = {}) {
  const execute = () => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: Boolean(onSpawn), stdio: ['inherit', 'pipe', 'pipe'] });
    onSpawn?.(child);
    const forwards = new Map();
    if (!onSpawn) for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => child.kill(signal);
      forwards.set(signal, handler); process.on(signal, handler);
    }
    const clearSignals = () => { for (const [signal, handler] of forwards) process.off(signal, handler); };
    child.once('close', clearSignals); child.once('error', clearSignals);
    let stdout = '', stderr = '';
    const capture = (stream, name) => {
      let pending = '';
      stream.setEncoding('utf8');
      const flush = final => {
        let boundary = final ? pending.length : pending.lastIndexOf('\n') + 1;
        if (!boundary && pending.length > 1024 * 1024) {
          // Never emit an unbounded/split potential credential line.
          pending = '[oversized child output line omitted]\n'; boundary = pending.length;
        }
        if (!boundary) return;
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary);
        const safe = redactOperatorText(raw, env);
        if (name === 'stdout') stdout = (stdout + safe).slice(-16 * 1024 * 1024);
        else stderr = (stderr + safe).slice(-16 * 1024 * 1024);
        if (emit) process[name].write(safe);
        sink?.(safe);
      };
      stream.on('data', chunk => { pending += chunk; flush(false); });
      stream.on('end', () => flush(true));
    };
    capture(child.stdout, 'stdout'); capture(child.stderr, 'stderr');
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ status: code ?? 128 + (os.constants.signals[signal] || 1), signal, stdout, stderr }));
  });
  return phase ? withOperatorPhase(label, async () => {
    const result = await execute();
    if (result.status !== 0) {
      const error = new Error(`${label} failed (exit=${result.status}${result.signal ? ` signal=${result.signal}` : ''}): ${(result.stderr || result.stdout).slice(-4000)}`);
      error.exitCode = result.status; throw error;
    }
    return result;
  }) : execute();
}
export function createOperatorRun({ root, operation, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const name = `${stamp}_${operation.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const runs = path.resolve(root, 'runs');
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  for (let suffix = 0; ; suffix++) {
    const directory = path.join(runs, name + (suffix ? `_${suffix}` : ''));
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    const fd = fs.openSync(path.join(directory, 'operator.log'), 'wx', 0o600);
    return { directory, fd };
  }
}
const argValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
export async function superviseOperatorInvocation(entry, args, env = process.env) {
  const operation = argValue(args, '--mode') || (entry.endsWith('preflight.sh') ? `preflight-${argValue(args, '--stage') || 'unknown'}` : args[0]);
  const authorityPath = argValue(args, '--authority-file') || argValue(args, '--checkpoint') || argValue(args, '--checkpoint-in');
  const reportArgument = argValue(args, '--report-out');
  const root = argValue(args, '--work-dir') || env.UK_AQ_OPERATOR_AUTHORITY_ROOT ||
    (authorityPath ? path.dirname(path.resolve(authorityPath)) : reportArgument ? path.dirname(path.resolve(reportArgument)) : path.join(os.homedir(), 'uk-aq-work/index_v3_operator'));
  const { directory, fd } = createOperatorRun({ root, operation: operation || 'operator' });
  const started = new Date();
  let logFailed = false;
  const log = text => {
    try { fs.writeSync(fd, redactOperatorText(text, env)); }
    catch { if (!logFailed) process.stderr.write('WARN: persistent operator log write failed; underlying exit status is preserved\n'); logFailed = true; }
  };
  const metadata = {
    kind: 'uk_aq_operator_run', diagnostic_only: true,
    environment: env.UKAQ_ENV_NAME || null, operation,
    transition: argValue(args, '--transition'), migration_run_id: argValue(args, '--migration-run-id'),
    repository: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    started_at_utc: started.toISOString(), pid: process.pid, run_directory: directory,
  };
  const inferredAuthority = argValue(args, '--authority-file') || path.resolve(root, 'operator_authority.json');
  const readStartAuthority = () => {
    try {
      // Diagnostic metadata must never materialise a large migration checkpoint.
      if (fs.statSync(inferredAuthority).size > 256 * 1024) return;
      const authority = JSON.parse(fs.readFileSync(inferredAuthority));
      metadata.migration_run_id ||= authority.migration_run_id || null;
      metadata.transition ||= authority.transition?.kind || authority.transition || null;
    } catch { /* may be unavailable before plan or on early failure */ }
  };
  readStartAuthority();
  metadata.git_head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: metadata.repository, encoding: 'utf8' }).stdout?.trim() || null;
  // Only explicitly named non-secret metadata is persisted, never argv or env.
  const announce = text => { process.stderr.write(text); log(text); };
  announce(`Operator run directory: ${directory}\n${JSON.stringify(metadata)}\n`);
  const defaults = { plan: 'migration_plan_report.json', migrate: 'migration_report.json', resume: 'migration_resume_report.json', verify: 'migration_verify_report.json', rollback: 'migration_rollback_report.json' };
  const domainPath = (reportArgument ? path.resolve(reportArgument) : null) || (defaults[operation] ? path.resolve(root, defaults[operation]) : null);
  if (logFailed) { fs.closeSync(fd); throw new Error('Initial operator log could not be written; operation not started'); }
  const reportBefore = domainPath && fs.existsSync(domainPath) ? fs.statSync(domainPath).mtimeMs : null;
  let result;
  const signals = new Map();
  try {
    result = await runOperatorCommand(process.execPath, [fileURLToPath(import.meta.url), 'phase', operation.startsWith('preflight-') ? 'Full preflight' : `Operator ${operation}`, entry.endsWith('.sh') ? 'bash' : process.execPath, entry, ...args], {
      cwd: process.cwd(), env: { ...env, UK_AQ_OPERATOR_SUPERVISED: '1', ...(operation.startsWith('preflight-') ? { UK_AQ_OPERATOR_PREFLIGHT_PHASE: '1' } : {}), UK_AQ_OPERATOR_RUN_DIR: directory, UK_AQ_OPERATOR_AUTHORITY_ROOT: path.resolve(root) },
      phase: false, sink: log,
      onSpawn(child) {
        metadata.child_pid = child.pid;
        // Preserve the wrapper's existing migrate SIGHUP policy, including children.
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
          const handler = () => {
            if (signal === 'SIGHUP' && operation === 'migrate') return;
            // Signal the invocation group, including a shell waiting on Node.
            // The existing lock coordinator still owns its protected child group.
            try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          };
          signals.set(signal, handler); process.on(signal, handler);
        }
      },
    });
  } catch (error) { announce(`Operator launch failed: ${redactOperatorText(error.message, env)}\n`); result = { status: 1 }; }
  finally { for (const [signal, handler] of signals) process.off(signal, handler); }
  let domainStatus = null;
  let domainReportWritten = false;
  try {
  if (domainPath && fs.existsSync(domainPath) && fs.statSync(domainPath).mtimeMs !== reportBefore) {
    domainReportWritten = true;
    if (fs.statSync(domainPath).size <= 8 * 1024 * 1024) {
      try { const d = JSON.parse(fs.readFileSync(domainPath)); domainStatus = d.result?.status || d.audit?.status || null; } catch { /* diagnostic only */ }
    }
  }
  } catch { /* diagnostic report inspection must not alter result */ }
  readStartAuthority();
  const summary = {
    ...metadata, completed_at_utc: new Date().toISOString(), elapsed_ms: Date.now() - started.getTime(),
    exit_code: result.status, signal: result.signal || null, success: result.status === 0,
    final_status: result.status === 0 ? domainStatus || 'succeeded' : 'failed',
    domain_status: domainStatus, domain_report_path: domainPath, domain_report_written_this_invocation: domainReportWritten,
    evidence_paths: [...new Set([inferredAuthority, authorityPath, path.resolve(root, 'migration_checkpoint.json'), path.resolve(root, 'writer_limits.json'), path.join(directory, 'runtime_recoverability.json'), argValue(args, '--plan-report'), argValue(args, '--out'), argValue(args, '--evidence'), argValue(args, '--runtime-operator-authority'), argValue(args, '--v2-runtime-rollback-record'), argValue(args, '--writer-freeze-evidence')].filter(Boolean).map(p => path.resolve(p)).filter(p => fs.existsSync(p)))],
    log_write_failed: logFailed,
  };
  announce(`Operator completion: UTC=${summary.completed_at_utc} elapsed=${formatElapsed(summary.elapsed_ms)} exit=${result.status} status=${summary.final_status} domain_report=${domainPath || 'none'} run_report=${path.join(directory, 'run_report.json')}\n`);
  announce(`Evidence paths: ${summary.evidence_paths.join(", ")}\n`);
  summary.log_write_failed = logFailed;
  try { fs.writeFileSync(path.join(directory, 'run_report.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { process.stderr.write('WARN: operator run report could not be written; underlying exit status is preserved\n'); }
  try { fs.closeSync(fd); } catch { process.stderr.write("WARN: operator log close failed\n"); }
  return result.status;
}
const main = isMainThread && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  const [mode, entry, ...args] = process.argv.slice(2);
  try {
    if (mode === 'run') process.exitCode = await superviseOperatorInvocation(path.resolve(entry), args);
    else if (mode === 'phase') {
      const [command, ...commandArgs] = args;
      const result = await runOperatorCommand(command, commandArgs, { label: entry });
      process.exitCode = result.status;
    } else throw new Error('Expected run ENTRY arguments or phase LABEL COMMAND arguments');
  } catch (error) { safeWrite(`${redactOperatorText(error.message)}\n`); process.exitCode = error.exitCode || 1; }
  finishOperatorProgress(process.exitCode ? 'failed' : 'complete');
}
