// Inert library: no CLI, scheduler, canonical reads, bootstrap or upload path.
import { randomUUID } from 'node:crypto';
import { r2GetObject, r2GetObjectBounded, r2PutObjectConditional, sha256Hex, isStrongR2Etag } from '../../workers/shared/r2_sigv4.mjs';
import { ROOT, CONTROL_KEY, ORDERING_BLOCKER, assertControl, createControl,
  assertReceipt, assertPruneReceiptGroup, assertReference, assertFailure, canonicalJson, same, monthKey, requireValid } from './schema.mjs';
import { assertControlSnapshot } from './control-snapshot.mjs';
import { retainedPruneEvent } from './prune-receipts.mjs';
import { retainedSelectedPruneEvent, retainedSelectedPruneBudget } from './prune-selected-event.mjs';
import { assertDescriptorReceipts, assertSelectedReceiptGroup } from './prune-event-schema.mjs';
import { readPruneEventDescriptor, readReceipt } from './inputs.mjs';
import { createBudget } from './limits.mjs';
import { assertManagedR2Target, assertManagedR2CredentialMode } from './r2-config.mjs';

export { managedR2ReadConfig, managedR2WriteConfig } from './r2-config.mjs';

export const MAX_CONTROL_BYTES = 4 * 1024 ** 2; // Admission cap, not an accepted operational scale.
export class JSONgenControlError extends Error {
  constructor(code, message, { latest = null, attempted = null, cause } = {}) {
    super(message, { cause });
    this.name = 'JSONgenControlError';
    this.code = code;
    this.state = code === 'superseded_publication_candidate' ? 'superseded' : 'reconcile_required';
    this.latest = latest;
    this.attempted = attempted;
  }
}
function admit(r2) {
  assertManagedR2Target(r2);
  if (r2.adapter) requireValid(typeof r2.adapter.getObject === 'function'
    && typeof r2.adapter.putObjectConditional === 'function', 'atomic read/CAS adapter required');
}
export async function readManagedControl(r2, { budget = null } = {}) {
  admit(r2);
  let stored;
  try {
    if (budget) {
      budget.get('derived');
      stored = await r2GetObjectBounded({ r2, key: CONTROL_KEY,
        max_bytes: Math.min(MAX_CONTROL_BYTES, budget.remainingBytes()), timeout_ms: budget.timeout() });
      budget.transfer?.('derived', stored.bytes);
      budget.bytes('derived', stored.bytes);
    } else stored = await r2GetObject({ r2, key: CONTROL_KEY, max_attempts: 1 });
  }
  catch (error) { if (error.status === 404) return null; throw error; }
  requireValid(stored.body instanceof Uint8Array && stored.body.byteLength <= MAX_CONTROL_BYTES
    && stored.bytes === stored.body.byteLength && isStrongR2Etag(stored.etag), 'invalid control body/ETag');
  const body = Buffer.from(stored.body);
  const control = assertControl(JSON.parse(body.toString('utf8')));
  // Exact bytes participate in revision evidence, including JSON encoding.
  return { control, body, sha256: sha256Hex(body), etag: stored.etag };
}
function reduce(current, command, now) {
  const next = structuredClone(current);
  if (command.type === 'retain_selected_prune_event') {
    const event = command.event;
    assertDescriptorReceipts(event.descriptor, event.descriptor_object, event.entries.map(e => e.receipt));
    requireValid(!Object.values(next.registered_changes).some(e => e.receipt.schema_version === 2
      && e.receipt.origin.authority.event_id === event.event_id), 'legacy original event already registered; replay schema 2');
    const record = { descriptor: event.descriptor_object, authority: event.original_authority, event: event.event,
      receipt_objects: event.entries.map(e => ({ change_id: e.receipt.change_id, receipt_object: e.receipt_object })) };
    const old = next.authenticated_events?.[event.event_id];
    if (old) {
      const { registered_at_utc: _at, ...prior } = old;
      requireValid(same(prior, record), 'original event identity reused with different descriptor, source, policy or group');
      assertControl(next); return null;
    }
    // The only v1 -> v2 transition adds the event map to the exact old state.
    // Revision/previous evidence are assigned by the existing CAS loop below.
    next.schema_version = 2; next.authenticated_events ||= {};
    next.authenticated_events[event.event_id] = { ...record, registered_at_utc: now };
    for (const entry of event.entries) addReceipt(next, entry, now);
    return next;
  }
  if (['retain_receipt', 'retain_prune_event'].includes(command.type)) {
    const entries = command.type === 'retain_prune_event' ? command.entries : [command];
    if (command.type === 'retain_prune_event') {
      assertPruneReceiptGroup(entries.map(e => e.receipt));
      requireValid(!next.authenticated_events?.[entries[0].receipt.origin.authority.event_id],
        'selected event already registered; legacy replay cannot replace it');
    }
    let changed = false;
    for (const command of entries) {
      changed = addReceipt(next, command, now) || changed;
    }
    if (!changed) return null;
  } else if (command.type === 'record_failure') {
    assertFailure(command.failure);
    if (command.month_key !== undefined) {
      const entry = next.months[command.month_key];
      requireValid(entry, 'unknown failure month');
      if (!same(entry.desired_change_ids, command.expected_desired_change_ids)
        || (entry.selected?.publication.pub_id ?? null) !== command.expected_pub_id) {
        throw new JSONgenControlError('superseded_publication_candidate', 'Failure report has stale month dependencies');
      }
      entry.failure = command.failure;
      entry.state = command.failure.state === 'failed_retryable' ? 'failed_retryable' : 'reconcile_required';
    } else next.failure = command.failure;
    next.freshness.state = 'reconcile_required';
  } else throw new TypeError('Unsupported Stage 1 control command');
  return next;
}
function addReceipt(next, command, now) {
  // Version 2 carries authenticated original Prune evidence. Neither receipt
  // format establishes current canonical dominance or monthly eligibility.
  assertReceipt(command.receipt);
  assertReference(command.receipt_object, { managed: true });
  const bytes = canonicalJson(command.receipt);
  requireValid(command.receipt_object.key === `${ROOT}/receipts/${sha256Hex(bytes)}.json`
    && command.receipt_object.sha256 === sha256Hex(bytes) && command.receipt_object.byte_size === bytes.length,
  'receipt descriptor mismatch');
  const eventId = command.receipt.change_id;
  const old = Object.hasOwn(next.registered_changes, eventId) ? next.registered_changes[eventId] : null;
  if (old) {
    requireValid(same(old.receipt, command.receipt) && same(old.receipt_object, command.receipt_object),
      'stable change ID reused for different evidence');
    return false; // Durable replay preserves lifecycle state.
  }
  next.registered_changes[eventId] = { receipt: command.receipt, receipt_object: command.receipt_object,
    registered_at_utc: now, state: [2, 3].includes(command.receipt.schema_version) ? 'verified_pending' : 'reconcile_required', ordering_state: 'unresolved',
    authentication_state: [2, 3].includes(command.receipt.schema_version) ? 'original_prune_event_authenticated' : 'pending_writer_adapter' };
  for (const m of command.receipt.affected_months) {
    const k = monthKey(m.identity, m.month_utc);
    const entry = next.months[k] ||= { ...m, desired_change_ids: [], applied_change_ids: [],
      selected: null, state: 'pending', failure: null };
    entry.desired_change_ids = [...entry.desired_change_ids, eventId].sort();
    entry.state = 'reconcile_required';
    entry.failure = { code: ORDERING_BLOCKER, state: 'reconcile_required', at_utc: now,
      detail: [2, 3].includes(command.receipt.schema_version)
        ? 'Original Prune event authenticated; current canonical dominance, other writer coverage and monthly baselines remain unresolved'
        : 'Receipt retained; current canonical scope precedence, receipt coverage and final-authority bundle authentication remain unverified' };
  }
  next.freshness.state = 'reconcile_required';
  return true;
}
// Selection has no unsafe substitute. Even a valid/readback-verified descriptor
// cannot bypass unauthenticated canonical-scope precedence/receipt coverage or
// the unresolved final-authority-to-bundle seam. No global counter is required.
export function selectManagedPublications() {
  throw new JSONgenControlError(ORDERING_BLOCKER,
    'Managed selection is disabled until canonical scope dominance, complete receipt coverage and final-authority bundle authentication are established');
}
export async function updateManagedControl({ r2, command, maxConflicts = 3, authenticatedPruneEvent = null,
  budget = null, authenticatedSelectedEvent = null }) {
  assertManagedR2CredentialMode(r2, 'write');
  admit(r2);
  if (command?.type === 'retain_selected_prune_event') {
    const operationBudget = retainedSelectedPruneBudget(authenticatedSelectedEvent);
    requireValid(budget === null || budget === operationBudget, 'selected registration must share original authentication budget');
    budget = operationBudget;
  }
  const bounded = budget !== null || ['retain_prune_event', 'retain_selected_prune_event'].includes(command?.type);
  budget ||= createBudget();
  const readOptions = { budget: bounded ? budget : null };
  requireValid(Number.isInteger(maxConflicts) && maxConflicts >= 0 && maxConflicts <= 5, 'invalid conflict budget');
  // Capture caller input before any await; a caller cannot alter the operation
  // between verification and a CAS retry.
  if (command?.type === 'retain_prune_event') {
    requireValid(Object.keys(command).length === 1, 'event registration accepts only an authenticated retained event token');
    const event = retainedPruneEvent(authenticatedPruneEvent);
    command = { type: 'retain_prune_event', entries: event.entries };
  }
  if (command?.type === 'retain_selected_prune_event') {
    requireValid(Object.keys(command).length === 1, 'selected registration accepts only a retained event capability');
    command = { type: command.type, event: retainedSelectedPruneEvent(authenticatedSelectedEvent) };
  }
  command = structuredClone(command);
  requireValid(['initialize', 'retain_receipt', 'retain_prune_event', 'retain_selected_prune_event', 'record_failure'].includes(command?.type), 'unsupported control command');
  if (command.type === 'retain_receipt') requireValid(command.receipt?.schema_version === 1,
    'version-2 Prune receipts require complete atomic event registration');
  if (command.type === 'retain_prune_event') {
    assertPruneReceiptGroup(command.entries.map(e => e.receipt));
    for (const entry of command.entries) await readReceipt({ r2, reference: entry.receipt_object, expected: entry.receipt, budget });
  }
  if (command.type === 'retain_selected_prune_event') {
    const event = command.event;
    const d = await readPruneEventDescriptor({ r2, reference: event.descriptor_object, expected: event.descriptor, budget });
    const receipts = [];
    for (const entry of event.entries) receipts.push(await readReceipt({ r2, reference: entry.receipt_object,
      expected: entry.receipt, budget }));
    assertDescriptorReceipts(d, event.descriptor_object, receipts);
  }
  if (command.expected_control_snapshot !== undefined) {
    requireValid(command.type === 'record_failure' && command.month_key === undefined,
      'exact control snapshot precondition is only supported for global failure reporting');
    assertControlSnapshot(command.expected_control_snapshot);
    requireValid(command.expected_control_snapshot.byte_provenance === 'exact_read',
      'global reconciliation failure requires original control bytes');
  }
  if (command.type === 'retain_receipt') {
    assertReceipt(command.receipt); assertReference(command.receipt_object, { managed: true });
    const ref = command.receipt_object;
    requireValid(ref.key === `${ROOT}/receipts/${ref.sha256}.json`
      && ref.byte_size <= MAX_CONTROL_BYTES, 'invalid immutable receipt key/size');
    let stored;
    try { stored = await r2GetObject({ r2, key: ref.key, max_attempts: 1 }); }
    catch (cause) { throw new JSONgenControlError('incomplete_source_change_registration', 'Immutable receipt unavailable', { cause }); }
    requireValid(stored.body instanceof Uint8Array && stored.body.byteLength === ref.byte_size
      && sha256Hex(stored.body) === ref.sha256 && Buffer.from(stored.body).equals(canonicalJson(command.receipt)),
    'immutable receipt readback mismatch');
  }
  let latest = await readManagedControl(r2, readOptions);
  for (let attempt = 0; attempt <= maxConflicts; attempt++) {
    budget.check();
    let next;
    if (command.type === 'initialize') {
      if (latest) return { outcome: 'already_initialized', latest };
      next = createControl();
    } else {
      if (!latest) throw new JSONgenControlError('missing_authenticated_baseline', 'Managed control is absent; explicit initialization required');
      // This check is inside the CAS loop: a 412 rereads and must not reapply a
      // diagnostic prepared for the former control revision or original bytes.
      const expected = command.expected_control_snapshot;
      if (expected && (latest.control.control_id !== expected.control_id ||
          latest.control.revision !== expected.revision ||
          latest.control.operation_id !== expected.operation_id ||
          latest.sha256 !== expected.sha256)) {
        return { outcome: 'stale_reconciliation_inspection', latest,
          expected_control_snapshot: expected, new_inspection_required: true };
      }
      next = reduce(latest.control, command, new Date().toISOString());
      if (!next) return { outcome: 'already_retained', latest };
      next.revision++;
      next.previous = { revision: latest.control.revision, operation_id: latest.control.operation_id, sha256: latest.sha256 };
      next.operation_id = randomUUID();
      next.updated_at_utc = new Date().toISOString();
    }
    assertControl(next);
    const body = canonicalJson(next);
    requireValid(body.length <= MAX_CONTROL_BYTES, 'control admission size exceeded');
    const expectedHash = sha256Hex(body);
    const attempted = { control_id: next.control_id, operation_id: next.operation_id,
      revision: next.revision, sha256: expectedHash };
    let outcome; let timer;
    try {
      const timeout = bounded ? budget.timeout() : null;
      if (bounded) budget.put?.(body.length);
      const write = r2PutObjectConditional({ r2, key: CONTROL_KEY, body, content_type: 'application/json', sha256: expectedHash,
        ...(latest ? { if_match: latest.etag } : { if_none_match: '*' }) });
      if (bounded) await Promise.race([write, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Control PUT deadline'),
          { code: 'R2_WRITE_AMBIGUOUS' })), timeout);
      })]);
      else await write;
      outcome = 'written';
    } catch (error) {
      if (error.code === 'R2_PRECONDITION_FAILED') {
        latest = await readManagedControl(r2, readOptions); // Reapply ONLY the bounded command to fresh state.
        if (attempt === maxConflicts) throw new JSONgenControlError('conditional_publication_conflict',
          'Conflict budget exhausted; current control preserved', { latest, cause: error });
        continue;
      }
      if (error.code !== 'R2_WRITE_AMBIGUOUS') throw error;
      outcome = 'confirmed_after_ambiguous_write';
    } finally { clearTimeout(timer); }
    // Both success and ambiguity inspect origin-authoritative state. Never retry
    // an ambiguous payload: a newer control may already have superseded it.
    try { latest = await readManagedControl(r2, readOptions); }
    catch (cause) { throw new JSONgenControlError('ambiguous_r2_write_outcome',
      'Control readback unavailable; retain operation evidence and reconcile before retry', { attempted, cause }); }
    if (latest?.sha256 === expectedHash && latest.control.operation_id === next.operation_id) return { outcome, latest };
    if (command.type === 'retain_selected_prune_event' && latest) {
      const e = command.event, registered = latest.control.authenticated_events?.[e.event_id];
      if (registered && same(registered.descriptor, e.descriptor_object)
        && same(registered.authority, e.original_authority) && same(registered.event, e.event)
        && same(registered.receipt_objects, e.entries.map(x => ({ change_id: x.receipt.change_id, receipt_object: x.receipt_object })))) {
        assertSelectedReceiptGroup(e.entries.map(x => x.receipt), registered.descriptor, registered.event, registered.authority);
        return { outcome: 'registered_confirmed_in_newer_control', latest };
      }
    }
    if (command.type === 'retain_prune_event' && latest && command.entries.every(entry => {
      const retained = latest.control.registered_changes[entry.receipt.change_id];
      return retained && same(retained.receipt, entry.receipt) && same(retained.receipt_object, entry.receipt_object);
    })) return { outcome: 'registered_confirmed_in_newer_control', latest };
    throw new JSONgenControlError('ambiguous_r2_write_outcome',
      `Unable to establish operation ${next.operation_id}; preserve current control and reconcile`, { latest, attempted });
  }
}
