import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { withObservationsGlobalOperationLock } from '../workers/shared/uk_aq_r2_history_writer.mjs';
import { runCommandWithObservationsGlobalOperationLock }
  from '../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs';
import { createPruneOriginalOperation, serveOriginalOperationAssertions, relayOriginalOperationAssertions,
  ORIGINAL_OPERATION_REPLY } from '../scripts/operations/lib/uk_aq_prune_original_operation.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const nonce = '22222222-2222-4222-8222-222222222222';
function pair() {
  const a = new EventEmitter(), b = new EventEmitter();
  a.connected = b.connected = true;
  a.send = (m, cb) => queueMicrotask(() => { cb?.(); b.emit('message', structuredClone(m)); });
  b.send = (m, cb) => queueMicrotask(() => { cb?.(); a.emit('message', structuredClone(m)); });
  return [a, b];
}
function database() {
  const client = new EventEmitter(), sql = [];
  let held = false, pid = 71;
  client.query = async text => {
    sql.push(text);
    if (text.includes('pg_try_advisory_lock')) { held = true; return { rows: [{ acquired: true }] }; }
    if (text.includes('pg_locks')) return { rows: [{ held, session_pid: pid }] };
    if (text.includes('pg_advisory_unlock')) { const released = held; held = false; return { rows: [{ released }] }; }
    return { rows: [] };
  };
  return { client, sql, lose: () => { held = false; }, replace: () => { pid++; }, restore: () => { held = true; pid = 71; } };
}
function bridge(lock) {
  const [coordinator, supervisorParent] = pair(), [supervisorChild, worker] = pair();
  let cancellations = 0, lastReply;
  worker.on('message', m => { if (m.type === ORIGINAL_OPERATION_REPLY) lastReply = m; });
  const cancel = () => { cancellations++; worker.connected = false; worker.emit('disconnect'); };
  const closeServer = serveOriginalOperationAssertions({ channel: coordinator, runId, nonce,
    assertOwned: () => lock.assertOwned(), onFailure: cancel });
  const closeRelay = relayOriginalOperationAssertions({ coordinator: supervisorParent, child: supervisorChild, onFailure: cancel });
  const operation = createPruneOriginalOperation({ channel: worker, runId, nonce });
  return { operation, worker, get lastReply() { return lastReply; }, get cancellations() { return cancellations; },
    close() { operation.close(); closeServer(); closeRelay(); } };
}
const locked = (db, fn) => withObservationsGlobalOperationLock({ client: db.client, owner: 'prune_daily',
  runId, heartbeatMs: 60000 }, async (_identity, lock) => { await lock.assertOwned(); return await fn(lock); });

test('original owner checks cross both IPC hops freshly; normal release invalidates an old capability', async () => {
  const db = database(); let b;
  try {
    await locked(db, async lock => {
      b = bridge(lock);
      for (const stage of ['publication', 'batch_finalization', 'preparation', 'gate_begin', 'gate_commit', 'gate_committed'])
        await b.operation.assertHeld(stage);
      assert.equal(db.sql.filter(s => s.includes('pg_locks')).length, 7);
    });
    const queries = db.sql.length;
    // No earlier failing proof or check: release happened in the real helper.
    await assert.rejects(b.operation.assertHeld('preparation'), { code: 'UK_AQ_PRUNE_ORIGINAL_OPERATION_LOST' });
    assert.equal(db.sql.length, queries, 'ended owner must not even query/reacquire');
    assert.equal(b.cancellations, 1);
    assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
  } finally { b?.close(); }
});

test('actual lock absence or replacement of the original backend fails closed and cannot resurrect', async () => {
  for (const action of ['lose', 'replace']) {
    const db = database(); let b, losses = 0;
    try {
      await assert.rejects(locked(db, async lock => {
        lock.signal.addEventListener('abort', () => { losses++; });
        b = bridge(lock); await b.operation.assertHeld();
        db[action]();
        await assert.rejects(b.operation.assertHeld(), { code: 'UK_AQ_PRUNE_ORIGINAL_OPERATION_LOST' });
        db.restore();
        await assert.rejects(b.operation.assertHeld());
      }), { code: 'UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOST' });
      assert.equal(losses, 1);
      assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
    } finally { b?.close(); }
  }
});

test('replaying a successful assertion invalidates the client rather than authorizing a later boundary', async () => {
  const db = database(); let b;
  try {
    await locked(db, async lock => {
      b = bridge(lock); await b.operation.assertHeld();
      const before = db.sql.length;
      b.worker.emit('message', b.lastReply);
      await assert.rejects(b.operation.assertHeld('gate_commit'), /stale or replaced/);
      assert.equal(db.sql.length, before);
    });
  } finally { b?.close(); }
});

test('bounded timeout and late success cannot restore an assertion capability', async () => {
  const [unused, worker] = pair(); let request;
  unused.on('message', m => { request = m; });
  const operation = createPruneOriginalOperation({ channel: worker, runId, nonce, timeoutMs: 15 });
  try {
    await assert.rejects(operation.assertHeld('gate_commit'), /timed out/);
    worker.emit('message', { ...request, type: ORIGINAL_OPERATION_REPLY, session_pid: 71 });
    await assert.rejects(operation.assertHeld(), /timed out/);
  } finally { operation.close(); }
});

test('the actual coordinator and child supervisor relay a live owner assertion without operational services', { timeout: 10000 }, async () => {
  const db = database();
  const moduleUrl = new URL('../scripts/operations/lib/uk_aq_prune_original_operation.mjs', import.meta.url).href;
  const contextUrl = new URL('../workers/shared/uk_aq_r2_history_writer.mjs', import.meta.url).href;
  const code = `import { createPruneOriginalOperation } from ${JSON.stringify(moduleUrl)};
    import { observationsGlobalOperationLockContext } from ${JSON.stringify(contextUrl)};
    const c = observationsGlobalOperationLockContext({ expectedOwner: 'prune_daily' });
    const o = createPruneOriginalOperation({ runId: c.run_id, nonce: c.nonce });
    await o.assertHeld('preparation'); await o.assertHeld('gate_commit'); await o.assertHeld('gate_committed');
    o.close(); process.disconnect();`;
  const exitCode = await runCommandWithObservationsGlobalOperationLock({
    databaseUrl: 'fixture-only', owner: 'prune_daily', runId, command: process.execPath,
    commandArgs: ['--input-type=module', '-e', code], heartbeatMs: 60000,
    withClient: async (_url, callback) => await callback(db.client),
  });
  assert.equal(exitCode, 0);
  assert.equal(db.sql.filter(s => s.includes('pg_locks')).length, 4);
  assert.equal(db.sql.filter(s => s.includes('pg_try_advisory_lock')).length, 1);
});
