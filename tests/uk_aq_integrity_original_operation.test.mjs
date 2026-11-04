import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withObservationsGlobalOperationLock, observationsGlobalOperationLockIdentity,
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV as LOCK_ENV } from '../workers/shared/uk_aq_r2_history_writer.mjs';
import { runCommandWithObservationsGlobalOperationLock } from '../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs';
import { createIntegrityOriginalOperation, serveIntegrityAssertions, relayIntegrityAssertions,
  INTEGRITY_ASSERT, INTEGRITY_REPLY, INTEGRITY_CHANNEL_ENV, assertOriginalIntegrityOperationHeld,
} from '../scripts/operations/lib/uk_aq_integrity_original_operation.mjs';

const runId = 'integrity:TEST:fixture';
const binding = Object.freeze({ owner: 'integrity', run_id: runId, nonce: randomUUID(),
  session_pid: 71, operation_lifetime: randomUUID() });
const turn = () => new Promise(resolve => setImmediate(resolve));
function ipcPair() {
  const a = new EventEmitter(), b = new EventEmitter();
  a.connected = b.connected = true;
  a.send = (m, cb) => queueMicrotask(() => { cb?.(); b.emit('message', structuredClone(m)); });
  b.send = (m, cb) => queueMicrotask(() => { cb?.(); a.emit('message', structuredClone(m)); });
  return [a, b];
}
function pipePair() {
  let a, b;
  const make = peer => new Duplex({
    read() {},
    write(chunk, _encoding, callback) { queueMicrotask(() => { peer().push(Buffer.from(chunk)); callback(); }); },
    final(callback) { queueMicrotask(() => { peer().push(null); callback(); }); },
    destroy(error, callback) { if (!peer().destroyed) peer().push(null); callback(error); },
  });
  a = make(() => b); b = make(() => a);
  a.on('error', () => {}); b.on('error', () => {});
  return [a, b];
}
function database() {
  const client = new EventEmitter(), sql = [];
  let held = false, pid = 71, pendingQuery = null;
  client.query = async text => {
    sql.push(text);
    if (text.includes('pg_try_advisory_lock')) { held = true; return { rows: [{ acquired: true }] }; }
    if (text.includes('pg_locks')) {
      if (pendingQuery) await pendingQuery;
      return { rows: [{ held, session_pid: pid }] };
    }
    if (text.includes('pg_advisory_unlock')) { const released = held; held = false; return { rows: [{ released }] }; }
    return { rows: [] };
  };
  return { client, sql, lose: () => { held = false; }, replace: () => { pid++; },
    restore: () => { held = true; pid = 71; }, block: promise => { pendingQuery = promise; } };
}
function bridge(lock, options = {}) {
  const [owner, supervisor] = ipcPair(), [relayPipe, childPipe] = pipePair();
  let cancellations = 0, lastReply;
  const cancel = () => { cancellations++; childPipe.destroy(); };
  supervisor.on('message', m => { if (m.type === INTEGRITY_REPLY) lastReply = m; });
  const closeServer = serveIntegrityAssertions({ channel: owner, binding, assertOwned: () => lock.assertOwned(),
    signal: lock.signal, onFailure: cancel, ...options });
  const closeRelay = relayIntegrityAssertions({ coordinator: supervisor, stream: relayPipe, binding, onFailure: cancel, ...options });
  const operation = createIntegrityOriginalOperation({ stream: childPipe, binding, ...options });
  return { operation, owner, supervisor, relayPipe, childPipe, get lastReply() { return lastReply; },
    get cancellations() { return cancellations; },
    close() { operation.close(); closeServer(); closeRelay(); childPipe.destroy(); } };
}
const locked = (db, fn) => withObservationsGlobalOperationLock({ client: db.client, owner: 'integrity', runId,
  heartbeatMs: 60000 }, async (_identity, lock) => { await lock.assertOwned(); return await fn(lock); });

test('every Integrity assertion queries the retained owner; completion gives no repair authority and prevents reuse', async () => {
  const db = database(); let b;
  try {
    await locked(db, async lock => {
      b = bridge(lock);
      const first = await b.operation.assertOriginalIntegrityOperationHeld();
      const second = await b.operation.assertOriginalIntegrityOperationHeld();
      assert.deepEqual([first.sequence, second.sequence], [1, 2]);
      assert.equal(first.session_pid, 71); assert.equal(first.repair_authorized, false);
      assert.equal(db.sql.filter(s => s.includes('pg_locks')).length, 3);
      await b.operation.complete(); await turn();
      await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld(), /lifetime ended/);
      assert.equal(b.cancellations, 0);
    });
    assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
    assert.equal(db.sql.filter(s => s.includes('pg_advisory_unlock')).length, 1);
  } finally { b?.close(); }
});

test('loss before or during assertion and original backend replacement permanently invalidate the operation', async () => {
  for (const action of ['lose', 'replace', 'pending_loss', 'signal_loss']) {
    const db = database(); let b;
    try {
      await assert.rejects(locked(db, async lock => {
        b = bridge(lock); await b.operation.assertOriginalIntegrityOperationHeld();
        if (action === 'pending_loss' || action === 'signal_loss') {
          let release;
          db.block(new Promise(resolve => { release = resolve; }));
          const assertion = assert.rejects(b.operation.assertOriginalIntegrityOperationHeld());
          await turn();
          if (action === 'signal_loss') {
            db.client.emit('error', new Error('original backend connection ended'));
            await assertion; // Must reject before the blocked query can return.
            release();
          } else {
            db.lose(); release(); await assertion;
          }
        } else {
          db[action](); await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld());
        }
        db.restore(); await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld());
      }), { code: 'UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOST' });
      assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
    } finally { b?.close(); }
  }
});

test('inherited context alone cannot assert the original session', async () => {
  const identity = observationsGlobalOperationLockIdentity();
  const env = { [LOCK_ENV.held]: 'true', [LOCK_ENV.acquired]: 'true', [LOCK_ENV.owner]: 'integrity',
    [LOCK_ENV.runId]: runId, [LOCK_ENV.nonce]: binding.nonce, [LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [LOCK_ENV.classId]: String(identity.class_id), [LOCK_ENV.objectId]: String(identity.object_id),
    [LOCK_ENV.waitMs]: '0', [LOCK_ENV.outcome]: 'held' };
  await assert.rejects(assertOriginalIntegrityOperationHeld({ env, expectedRunId: runId }), /no original-session channel/);
});

test('client rejects mismatched responses while an assertion is pending and never falls back', async () => {
  for (const changed of [{ owner: 'prune_daily' }, { run_id: 'other' }, { nonce: randomUUID() },
    { session_pid: 72 }, { operation_lifetime: randomUUID() }, { sequence: 2 },
    { challenge: randomUUID() }, { child_lifetime: randomUUID() }]) {
    const [peer, child] = pipePair();
    const operation = createIntegrityOriginalOperation({ stream: child, binding });
    peer.once('data', chunk => {
      const request = JSON.parse(chunk.toString());
      peer.write(`${JSON.stringify({ ...request, type: INTEGRITY_REPLY, ...changed })}\n`);
    });
    await assert.rejects(operation.assertOriginalIntegrityOperationHeld(), /mismatched response/);
    await assert.rejects(operation.assertOriginalIntegrityOperationHeld(), /mismatched response/);
    operation.close(); peer.destroy();
  }
});

test('wrong owner/run/nonce/session/lifetime, invalid sequence/challenge and duplicated challenges fail at original owner', async () => {
  const valid = { ...binding, type: INTEGRITY_ASSERT, sequence: 1, challenge: randomUUID(), child_lifetime: randomUUID() };
  for (const changed of [{ owner: 'prune_daily' }, { run_id: 'other' }, { nonce: randomUUID() },
    { session_pid: 72 }, { operation_lifetime: randomUUID() }, { sequence: 0 }, { sequence: 2 },
    { challenge: 'copied' }, { child_lifetime: 'wrong' }]) {
    const [owner, child] = ipcPair(); let queries = 0, failures = 0;
    const close = serveIntegrityAssertions({ channel: owner, binding,
      assertOwned: async () => { queries++; return 71; }, onFailure: () => { failures++; } });
    child.send({ ...valid, ...changed }); await turn();
    child.send(valid); await turn();
    assert.equal(queries, 0); assert.ok(failures >= 1); close();
  }
  for (const next of [{ sequence: 1, challenge: randomUUID() }, { sequence: 2, challenge: valid.challenge }]) {
    const [owner, child] = ipcPair(); let queries = 0, failures = 0;
    const close = serveIntegrityAssertions({ channel: owner, binding,
      assertOwned: async () => { queries++; return 71; }, onFailure: () => { failures++; } });
    child.send(valid); await turn(); child.send({ ...valid, ...next }); await turn();
    assert.equal(queries, 1); assert.equal(failures, 1); close();
  }
});

test('replayed and cross-operation replies cancel the relay; prior success cannot be reused', async () => {
  for (const changed of [{}, { run_id: 'other' }, { nonce: randomUUID() }, { session_pid: 72 },
    { sequence: 2 }, { challenge: randomUUID() }, { child_lifetime: randomUUID() }]) {
    const db = database(); let b;
    try {
      await locked(db, async lock => {
        b = bridge(lock); await b.operation.assertOriginalIntegrityOperationHeld();
        b.supervisor.emit('message', { ...b.lastReply, ...changed }); await turn();
        await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld());
        assert.ok(b.cancellations > 0);
      });
    } finally { b?.close(); }
  }
});

test('overlapping client and owner assertions, timeout, disconnect, broken pipe and cancellation are permanent', async () => {
  for (const action of ['overlap', 'timeout', 'disconnect', 'pipe', 'cancel']) {
    const db = database(); let b;
    try {
      await locked(db, async lock => {
        let release;
        db.block(new Promise(resolve => { release = resolve; }));
        b = bridge(lock, { timeoutMs: 25 });
        const pending = b.operation.assertOriginalIntegrityOperationHeld();
        // Attach rejection handling before triggering cancellation.
        const rejection = assert.rejects(pending);
        if (action === 'overlap') await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld(), /overlapping/);
        if (action === 'disconnect') b.supervisor.emit('disconnect');
        if (action === 'pipe') b.relayPipe.destroy();
        if (action === 'cancel') b.operation.close();
        await rejection; release(); await turn();
        await assert.rejects(b.operation.assertOriginalIntegrityOperationHeld());
      });
    } finally { b?.close(); }
  }
  const [owner, child] = ipcPair(); let release, queries = 0, failures = 0;
  const close = serveIntegrityAssertions({ channel: owner, binding,
    assertOwned: () => { queries++; return new Promise(resolve => { release = resolve; }); },
    onFailure: () => { failures++; } });
  const request = { ...binding, type: INTEGRITY_ASSERT, sequence: 1, challenge: randomUUID(), child_lifetime: randomUUID() };
  child.send(request); await turn(); child.send({ ...request, sequence: 2, challenge: randomUUID() }); await turn();
  release(71); await turn(); assert.equal(queries, 1); assert.equal(failures, 1); close();
});

test('bounded framing rejects malformed/oversized payloads and unsolicited client success', async () => {
  for (const payload of ['not-json\n', 'x'.repeat(2049), JSON.stringify({ ...binding, type: INTEGRITY_REPLY }) + '\n']) {
    const [relay, child] = pipePair(); let failures = 0;
    const operation = createIntegrityOriginalOperation({ stream: child, binding, onFailure: () => { failures++; } });
    relay.write(payload); await turn();
    await assert.rejects(operation.assertOriginalIntegrityOperationHeld());
    assert.equal(failures, 1); operation.close(); relay.destroy();
  }
});

// Invoke the exact production Python run_canonical_apply_executor AST with only
// local proposal-validation stubs. The real supervisor, inherited fd handoff and
// both bridge assertion exports run in separate OS processes. No operational
// main/configuration/source/R2 path is invoked by the harness.
test('actual holder/supervisor/Python canonical Popen/Node bridge chain asserts and tears down without services', { timeout: 20000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-original-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const impl = path.join(root, 'scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py');
  const nodeHarness = path.join(dir, 'node-apply.mjs');
  const moduleUrl = new URL('../scripts/operations/lib/uk_aq_integrity_original_operation.mjs', import.meta.url).href;
  fs.writeFileSync(nodeHarness, `#!${process.execPath}
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { integrityOriginalOperationForApply } from ${JSON.stringify(moduleUrl)};
fs.writeFileSync(process.env.STAGE2J_TEST_PID_PATH, String(process.pid));
const bridge = await import(pathToFileURL(process.argv[2]));
const c = integrityOriginalOperationForApply({ expectedRunId: process.env.UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_RUN_ID });
const action = process.env.STAGE2J_TEST_ACTION || 'normal';
if (action === 'unused') { await c.complete(); console.log('{}'); process.exit(0); }
const a = await bridge.assertOriginalIntegrityOperationHeld();
const b = await bridge.assertOriginalIntegrityOperationHeld();
if (a.session_pid !== 71 || b.sequence !== 2 || a.repair_authorized !== false) process.exit(9);
if (action === 'node-exit') process.exit(23);
if (action === 'python-exit') { process.kill(process.ppid, 'SIGKILL'); await new Promise(() => {}); }
if (action === 'supervisor-exit') { process.kill(Number(process.env.STAGE2J_TEST_SUPERVISOR_PID), 'SIGKILL'); await new Promise(() => {}); }
await c.complete(); console.log('{}');
`, { mode: 0o755 });
  const pythonHarness = path.join(dir, 'python3');
  fs.writeFileSync(pythonHarness, `#!/usr/bin/env python3
import ast, sys, os, json, subprocess, shutil, threading, logging
from pathlib import Path
from typing import Any, Mapping
logging.basicConfig(level=logging.INFO)
impl = Path(sys.argv[1])
sys.path.insert(0, str(impl.parent))
from integrity.original_operation import ORIGINAL_INTEGRITY_CHANNEL, CHANNEL_ENV
assert CHANNEL_ENV not in os.environ
os.environ['STAGE2J_TEST_SUPERVISOR_PID'] = str(os.getppid())
if os.environ.get('STAGE2J_TEST_ACTION') == 'no-apply': sys.exit(0)
# An unrelated subprocess receives neither metadata nor the live descriptor.
subprocess.run([sys.executable, '-c', 'import os; assert "${INTEGRITY_CHANNEL_ENV}" not in os.environ;\\ntry: os.fstat(3)\\nexcept OSError: pass\\nelse: raise AssertionError("descriptor leaked")'], check=True)
tree = ast.parse(impl.read_text())
function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run_canonical_apply_executor')
scope = globals()
scope.update(_require_complete_persisted_file_backed_proposal=lambda s: None,
 validate_run_state_core_snapshot_identity=lambda *a, **k: None,
 validate_proposal_run_state_transition=lambda *a, **k: {},
 proposal_transition_state_fingerprint_sha256=lambda s: 'fixture',
 fmt_iso=lambda t: 'fixture', utc_now=lambda: None,
 write_run_state=lambda s: Path(s['run_state_path']).write_text(json.dumps(s)),
 _tail_bytes=lambda value, size: value[-size:],
 _repo_root_for_integrity_script=lambda e: Path(${JSON.stringify(root)}),
 SOS_HISTORICAL_REPLACEMENT_EXECUTION_PATH='sos_light',
 SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT='fixture',
 GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT='fixture')
exec(compile(ast.Module(body=[function], type_ignores=[]), str(impl), 'exec'), scope)
state = {'execution_path': sys.argv[2], 'run_state_path': sys.argv[3]}
result = run_canonical_apply_executor(run_state=state, env=os.environ, log=logging.getLogger('fixture'))
assert result['status'] == ('failed' if os.environ.get('STAGE2J_TEST_ACTION') == 'node-exit' else 'succeeded'), result
`, { mode: 0o755 });
  for (const [executionPath, action] of [
    ['generic_integrity', 'normal'], ['sos_light', 'normal'], ['generic_integrity', 'unused'],
    ['generic_integrity', 'no-apply'], ['generic_integrity', 'node-exit'],
    ['generic_integrity', 'python-exit'], ['generic_integrity', 'supervisor-exit'],
  ]) {
    const db = database();
    const pidPath = path.join(dir, executionPath + '-' + action + '.pid');
    const result = runCommandWithObservationsGlobalOperationLock({
      databaseUrl: 'fixture-only', owner: 'integrity', runId, command: pythonHarness,
      commandArgs: [impl, executionPath, path.join(dir, 'run.json')], heartbeatMs: 60000,
      env: { ...process.env, UK_AQ_BACKFILL_NODE_BIN: nodeHarness, STAGE2J_TEST_ACTION: action, STAGE2J_TEST_PID_PATH: pidPath },
      withClient: async (_url, callback) => callback(db.client),
    });
    if (action.endsWith('exit')) await assert.rejects(result);
    else assert.equal(await result, 0, action);
    assert.equal(db.sql.filter(s => s.includes('pg_locks')).length, ['unused', 'no-apply'].includes(action) ? 1 : 3);
    assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
    assert.equal(db.sql.filter(s => s.includes('pg_advisory_unlock')).length, 1);
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8'));
      const running = () => {
        try {
          process.kill(pid, 0);
          if (process.platform === 'linux') return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
          return true;
        } catch (error) {
          if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
          throw error;
        }
      };
      const deadline = Date.now() + 3000;
      while (running() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(running(), false, `${action}: APPLY must have stopped before delivery completes`);
    }
  }
});
