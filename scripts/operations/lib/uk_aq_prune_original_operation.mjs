// Private, operation-lifetime IPC only. No acknowledgement is durable evidence.
import { randomUUID } from 'node:crypto';

export const ORIGINAL_OPERATION_REQUEST = 'uk_aq_prune_original_operation_assert';
export const ORIGINAL_OPERATION_REPLY = 'uk_aq_prune_original_operation_reply';
const STAGES = new Set(['publication', 'batch_finalization', 'preparation', 'gate_begin', 'gate_commit', 'gate_committed']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function originalOperationError(reason) {
  return Object.assign(new Error(`Original Prune operation unavailable: ${reason}`),
    { code: 'UK_AQ_PRUNE_ORIGINAL_OPERATION_LOST' });
}
export function isOriginalOperationError(error) {
  return error?.code === 'UK_AQ_PRUNE_ORIGINAL_OPERATION_LOST'
    || error?.code === 'UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOST';
}
function send(channel, message, fail) {
  try {
    if (!channel?.connected || typeof channel.send !== 'function') throw originalOperationError('IPC disconnected');
    channel.send(message, error => { if (error) fail(); });
  } catch { fail(); }
}

// Coordinator end: requests are serialized and never replayable, including
// requests whose original session check failed. The actual lock callback owns
// the PostgreSQL query and latches loss; this endpoint cannot acquire a lock.
export function serveOriginalOperationAssertions({ channel, runId, nonce, assertOwned, onFailure }) {
  let closed = false, busy = false, sequence = 0;
  const fail = () => { if (!closed) { closed = true; onFailure?.(); } };
  const receive = async message => {
    if (message?.type !== ORIGINAL_OPERATION_REQUEST || closed) return;
    if (busy || message.run_id !== runId || message.nonce !== nonce
      || message.sequence !== sequence + 1 || !UUID.test(message.challenge || '') || !STAGES.has(message.stage)) {
      fail(); return;
    }
    sequence = message.sequence; busy = true;
    try {
      const sessionPid = await assertOwned();
      if (closed) return;
      if (!Number.isSafeInteger(sessionPid) || sessionPid <= 0) throw originalOperationError('session identity missing');
      send(channel, { type: ORIGINAL_OPERATION_REPLY, run_id: runId, nonce,
        sequence, challenge: message.challenge, session_pid: sessionPid }, fail);
    } catch { fail(); }
    finally { busy = false; }
  };
  channel.on('message', receive);
  return () => { closed = true; channel.off('message', receive); };
}

// Existing child supervisor is the sole relay. At most one small request is
// outstanding. It cannot generate a success reply or extend the owner's life.
export function relayOriginalOperationAssertions({ coordinator, child, onFailure }) {
  let pending = null, closed = false;
  const fail = () => { if (!closed) { closed = true; onFailure(); } };
  const request = message => {
    if (message?.type !== ORIGINAL_OPERATION_REQUEST || closed) return;
    if (pending || JSON.stringify(message).length > 1024) { fail(); return; }
    pending = message;
    send(coordinator, message, fail);
  };
  const reply = message => {
    if (message?.type !== ORIGINAL_OPERATION_REPLY || closed) return;
    if (!pending || message.sequence !== pending.sequence || message.challenge !== pending.challenge
      || message.run_id !== pending.run_id || message.nonce !== pending.nonce) { fail(); return; }
    pending = null;
    send(child, message, fail);
  };
  child.on('message', request); coordinator.on('message', reply);
  return () => { closed = true; pending = null; child.off('message', request); coordinator.off('message', reply); };
}

// Worker end: no cached success is reusable. Timeout, disconnect, a stale reply,
// changed session or local close permanently invalidates this capability.
export function createPruneOriginalOperation({ channel = process, runId, nonce, timeoutMs = 5000 }) {
  let sequence = 0, sessionPid = null, pending = null, failure = null;
  const fail = reason => {
    failure ||= originalOperationError(reason);
    if (pending) { clearTimeout(pending.timer); const reject = pending.reject; pending = null; reject(failure); }
  };
  const receive = message => {
    if (message?.type !== ORIGINAL_OPERATION_REPLY) return;
    if (!pending || message.run_id !== runId || message.nonce !== nonce
      || message.sequence !== pending.sequence || message.challenge !== pending.challenge
      || !Number.isSafeInteger(message.session_pid) || message.session_pid <= 0
      || (sessionPid !== null && sessionPid !== message.session_pid)) { fail('stale or replaced session assertion'); return; }
    sessionPid = message.session_pid;
    clearTimeout(pending.timer); const resolve = pending.resolve; pending = null; resolve();
  };
  const disconnect = () => fail('IPC disconnected');
  channel.on('message', receive); channel.on('disconnect', disconnect);
  return Object.freeze({
    run_id: runId,
    async assertHeld(stage = 'publication') {
      if (failure) throw failure;
      if (pending || !STAGES.has(stage)) { fail('overlapping or invalid assertion'); throw failure; }
      await new Promise((resolve, reject) => {
        const challenge = randomUUID();
        const timer = setTimeout(() => fail('assertion timed out'), Math.min(5000, Math.max(1, timeoutMs)));
        pending = { resolve, reject, timer, challenge, sequence: ++sequence };
        send(channel, { type: ORIGINAL_OPERATION_REQUEST, run_id: runId, nonce,
          sequence, challenge, stage }, () => fail('IPC send failed'));
      });
      if (failure) throw failure;
    },
    close() {
      fail('operation ended'); channel.off('message', receive); channel.off('disconnect', disconnect);
    },
  });
}
