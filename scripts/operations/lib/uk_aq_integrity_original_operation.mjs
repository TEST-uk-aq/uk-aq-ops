// Private process-lifetime capability. Context/descriptor possession is not lock
// proof: every assertion must be answered by the retained PostgreSQL lock owner.
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requireObservationsGlobalOperationLockContext } from '../../../workers/shared/uk_aq_r2_history_writer.mjs';

// Internal spawn metadata, never an operator/environment configuration setting.
export const INTEGRITY_CHANNEL_ENV = 'UK_AQ_INTEGRITY_ORIGINAL_OPERATION_CHANNEL';
export const INTEGRITY_ASSERT = 'uk_aq_integrity_original_assert';
export const INTEGRITY_REPLY = 'uk_aq_integrity_original_reply';
export const INTEGRITY_END = 'uk_aq_integrity_original_end';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 2048;
const TIMEOUT_MS = 5000;
const BINDING_KEYS = ['owner', 'run_id', 'nonce', 'session_pid', 'operation_lifetime'];
const COORDINATOR = fileURLToPath(new URL('../../uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py', import.meta.url));

export function isIntegrityCoordinator({ command, commandArgs = [] } = {}) {
  return /^python(?:3(?:\.\d+)?)?$/.test(path.basename(command || ''))
    && typeof commandArgs[0] === 'string' && path.resolve(commandArgs[0]) === COORDINATOR;
}
export function integrityOperationError(reason) {
  return Object.assign(new Error(`Original Integrity operation unavailable: ${reason}`),
    { code: 'UK_AQ_INTEGRITY_ORIGINAL_OPERATION_LOST' });
}
function validBinding(b) {
  return b?.owner === 'integrity' && typeof b.run_id === 'string'
    && b.run_id.length > 0 && b.run_id.length <= 256 && UUID.test(b.nonce || '')
    && UUID.test(b.operation_lifetime || '') && Number.isSafeInteger(b.session_pid) && b.session_pid > 0;
}
function matches(message, binding) {
  return BINDING_KEYS.every(key => message?.[key] === binding[key]);
}
function validRequest(message, binding) {
  return matches(message, binding) && UUID.test(message.child_lifetime || '')
    && UUID.test(message.challenge || '') && Number.isSafeInteger(message.sequence) && message.sequence > 0;
}
function send(channel, message, fail) {
  try {
    if (!channel?.connected || typeof channel.send !== 'function') throw integrityOperationError('IPC disconnected');
    channel.send(message, error => { if (error) fail(integrityOperationError('IPC send failed')); });
  } catch (error) { fail(error); }
}

// No acquisition API is accepted here. The callback is closed over the actual
// original lock object; its signal and identity are checked around every query.
export function serveIntegrityAssertions({ channel, binding, assertOwned, signal, onFailure, timeoutMs = TIMEOUT_MS }) {
  if (!validBinding(binding)) throw integrityOperationError('invalid original binding');
  let closed = false, pending = null, sequence = 0, childLifetime = null;
  const challenges = new Set();
  // Bound memory as well as wire size; this interface is for finite admission.
  const fail = reason => {
    if (closed) return;
    closed = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    onFailure?.(integrityOperationError(reason?.message || String(reason)));
  };
  const disconnected = () => fail('IPC disconnected');
  const lost = () => fail(signal.reason || 'original lock lost');
  const receive = async message => {
    if (![INTEGRITY_ASSERT, INTEGRITY_END].includes(message?.type)) return;
    if (closed) { onFailure?.(integrityOperationError('request after operation ended')); return; }
    if (message.type === INTEGRITY_END) {
      if (pending || !matches(message, binding) || message.sequence !== sequence
        || (childLifetime !== null && message.child_lifetime !== childLifetime)
        || (message.child_lifetime !== null && !UUID.test(message.child_lifetime || ''))) {
        fail('invalid completion'); return;
      }
      closed = true;
      return;
    }
    if (signal?.aborted || pending || !validRequest(message, binding) || message.sequence !== sequence + 1
      || challenges.has(message.challenge) || sequence >= 1024
      || (childLifetime !== null && message.child_lifetime !== childLifetime)) {
      fail('overlapping, stale or mismatched request'); return;
    }
    sequence = message.sequence;
    childLifetime = message.child_lifetime;
    challenges.add(message.challenge);
    const request = { ...message };
    const current = { timer: setTimeout(() => fail('assertion timed out'), Math.min(TIMEOUT_MS, Math.max(1, timeoutMs))) };
    pending = current;
    try {
      const sessionPid = await assertOwned();
      if (closed || pending !== current) return;
      if (signal?.aborted || sessionPid !== binding.session_pid) throw integrityOperationError('original session changed');
      clearTimeout(current.timer);
      pending = null;
      send(channel, { ...request, type: INTEGRITY_REPLY }, fail);
    } catch (error) { fail(error); }
  };
  channel.on('message', receive);
  channel.on('disconnect', disconnected);
  signal?.addEventListener('abort', lost, { once: true });
  if (signal?.aborted) lost();
  return () => {
    closed = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    channel.off('message', receive);
    channel.off('disconnect', disconnected);
    signal?.removeEventListener('abort', lost);
  };
}

// Small newline-delimited frames on one private inherited duplex descriptor.
// A frame is bounded before JSON parsing. No filesystem socket/network listener.
function framedPipe(stream, receive, fail, ended) {
  let buffer = Buffer.alloc(0);
  const data = chunk => {
    if (buffer.length + chunk.length > LIMIT) { fail('oversized frame'); return; }
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const index = buffer.indexOf(10);
      if (index < 0) { if (buffer.length > LIMIT) fail('oversized frame'); return; }
      if (index > LIMIT || index === 0) { fail('invalid frame size'); return; }
      const frame = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
      try { receive(JSON.parse(frame.toString('utf8'))); } catch (error) { fail(error); return; }
    }
  };
  const error = () => fail('broken assertion pipe');
  const end = () => ended(buffer.length !== 0);
  stream.on('data', data); stream.on('error', error); stream.on('end', end); stream.on('close', end);
  return () => { stream.off('data', data); stream.off('end', end); stream.off('close', end); };
}
function write(stream, message, fail) {
  try {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > LIMIT || stream.destroyed || !stream.writable) throw integrityOperationError('closed assertion pipe');
    stream.write(frame, error => { if (error) fail('broken assertion pipe'); });
  } catch (error) { fail(error); }
}

// The supervisor forwards only Integrity messages and never invents a reply.
export function relayIntegrityAssertions({ coordinator, stream, binding, onFailure, timeoutMs = TIMEOUT_MS }) {
  let closed = false, completed = false, pending = null, sequence = 0, childLifetime = null;
  const fail = reason => {
    if (closed) return;
    closed = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    stream.destroy();
    onFailure(integrityOperationError(reason?.message || String(reason)));
  };
  const request = message => {
    if (closed) return;
    if (message?.type === INTEGRITY_END && matches(message, binding) && !pending
      && message.sequence === sequence && (childLifetime === null || childLifetime === message.child_lifetime)
      && (message.child_lifetime === null || UUID.test(message.child_lifetime || ''))) {
      completed = true; closed = true;
      send(coordinator, message, error => onFailure(error));
      return;
    }
    if (message?.type !== INTEGRITY_ASSERT || pending || !validRequest(message, binding)
      || message.sequence !== sequence + 1 || (childLifetime !== null && message.child_lifetime !== childLifetime)) {
      fail('invalid or overlapping child request'); return;
    }
    sequence = message.sequence; childLifetime = message.child_lifetime;
    pending = { message, timer: setTimeout(() => fail('assertion timed out'), Math.min(TIMEOUT_MS, Math.max(1, timeoutMs))) };
    send(coordinator, message, fail);
  };
  const reply = message => {
    if (message?.type !== INTEGRITY_REPLY) return;
    if (closed || !pending || !matches(message, binding) || message.sequence !== pending.message.sequence
      || message.challenge !== pending.message.challenge || message.child_lifetime !== childLifetime) {
      if (closed) onFailure(integrityOperationError('reply after completion'));
      else fail('stale or mismatched owner response');
      return;
    }
    clearTimeout(pending.timer); pending = null;
    write(stream, message, fail);
  };
  const disconnected = () => fail('supervisor IPC disconnected');
  const unframe = framedPipe(stream, request, fail, () => { if (!completed) fail('assertion pipe closed'); });
  coordinator.on('message', reply); coordinator.on('disconnect', disconnected);
  return () => {
    closed = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    coordinator.off('message', reply); coordinator.off('disconnect', disconnected);
    unframe(); stream.destroy();
  };
}

// Explicit injected streams support deterministic checks. Production receives
// its descriptor only from the one-shot Python handoff, never from lock context.
export function createIntegrityOriginalOperation({ stream, binding, onFailure = () => {}, timeoutMs = TIMEOUT_MS }) {
  if (!validBinding(binding)) throw integrityOperationError('invalid original binding');
  const childLifetime = randomUUID();
  let sequence = 0, pending = null, failure = null, completed = false;
  const fail = reason => {
    if (failure || completed) return;
    failure = integrityOperationError(reason?.message || String(reason));
    if (pending) { clearTimeout(pending.timer); pending.reject(failure); pending = null; }
    stream.destroy(); onFailure(failure);
  };
  const receive = message => {
    if (failure) return;
    if (message?.type !== INTEGRITY_REPLY || !pending || !matches(message, binding)
      || message.sequence !== pending.sequence || message.challenge !== pending.challenge
      || message.child_lifetime !== childLifetime) { fail('replayed or mismatched response'); return; }
    clearTimeout(pending.timer); const resolve = pending.resolve; pending = null;
    resolve(Object.freeze({ owner: 'integrity', run_id: binding.run_id, session_pid: binding.session_pid,
      sequence: message.sequence, read_only: true, repair_authorized: false }));
  };
  const unframe = framedPipe(stream, receive, fail, () => fail('assertion pipe closed'));
  return Object.freeze({
    async assertOriginalIntegrityOperationHeld() {
      if (failure) throw failure;
      if (completed) throw integrityOperationError('APPLY lifetime ended');
      if (pending || sequence >= 1024) { fail('overlapping assertion or assertion limit'); throw failure; }
      const result = await new Promise((resolve, reject) => {
        const challenge = randomUUID();
        pending = { resolve, reject, challenge, sequence: ++sequence,
          timer: setTimeout(() => fail('assertion timed out'), Math.min(TIMEOUT_MS, Math.max(1, timeoutMs))) };
        write(stream, { ...binding, type: INTEGRITY_ASSERT, sequence, challenge, child_lifetime: childLifetime }, fail);
      });
      if (failure) throw failure;
      return result;
    },
    async complete() {
      if (failure) throw failure;
      if (completed) return;
      if (pending) { fail('completion during assertion'); throw failure; }
      await new Promise((resolve, reject) => {
        stream.end(`${JSON.stringify({ ...binding, type: INTEGRITY_END, sequence, child_lifetime: childLifetime })}\n`, error => {
          if (error) { fail(error); reject(failure); } else resolve();
        });
      });
      if (failure) throw failure;
      completed = true; unframe(); stream.destroy();
    },
    close() { fail('APPLY cancelled'); unframe(); },
  });
}

let processCapability = null;
export function integrityOriginalOperationForApply({ env = process.env, expectedRunId } = {}) {
  const context = requireObservationsGlobalOperationLockContext({ env, expectedOwner: 'integrity', expectedRunId });
  if (processCapability) {
    if (!matches({ ...context, session_pid: processCapability.binding.session_pid,
      operation_lifetime: processCapability.binding.operation_lifetime }, processCapability.binding)) {
      processCapability.operation.close(); throw integrityOperationError('APPLY run changed');
    }
    return processCapability.operation;
  }
  const raw = env[INTEGRITY_CHANNEL_ENV];
  if (!raw) return null; // Existing schema-1 callers without a channel retain their context gate.
  let metadata;
  try { metadata = JSON.parse(raw); } catch { throw integrityOperationError('invalid descriptor metadata'); }
  const { fd, binding } = metadata;
  if (fd !== 3 || !validBinding(binding) || binding.run_id !== context.run_id || binding.nonce !== context.nonce) {
    throw integrityOperationError('descriptor/run binding mismatch');
  }
  const stream = new Socket({ fd, readable: true, writable: true });
  // A live child must not continue after its capability becomes uncertain.
  const operation = createIntegrityOriginalOperation({ stream, binding,
    onFailure: () => process.kill(process.pid, 'SIGTERM') });
  processCapability = { binding, operation };
  return operation;
}

export async function assertOriginalIntegrityOperationHeld(options = {}) {
  const operation = integrityOriginalOperationForApply(options);
  if (!operation) throw integrityOperationError('no original-session channel');
  return await operation.assertOriginalIntegrityOperationHeld();
}
