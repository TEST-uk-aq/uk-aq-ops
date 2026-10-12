// Exact original-byte control identity for optional Stage 2 failure fencing.
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { assertControl, canonicalJson, requireValid, same } from './schema.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const changeId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const safe = n => Number.isSafeInteger(n) && n >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function assertControlSnapshot(value) {
  const fields = ['control_id', 'revision', 'operation_id', 'sha256', 'byte_provenance', 'registered_change_ids'];
  requireValid(object(value) && fields.every(k => Object.hasOwn(value, k))
    && Object.keys(value).every(k => fields.includes(k))
    && uuid.test(value.control_id) && safe(value.revision) && uuid.test(value.operation_id)
    && sha.test(value.sha256) && ['exact_read', 'canonical_projection'].includes(value.byte_provenance)
    && Array.isArray(value.registered_change_ids)
    && value.registered_change_ids.every(id => changeId.test(id))
    && same(value.registered_change_ids, [...new Set(value.registered_change_ids)].sort()),
  'invalid control snapshot identity or provenance');
  return value;
}

// A control object alone cannot prove the bytes originally read from R2. Only
// readManagedControl's raw body can supply an exact-byte inspection snapshot.
export function controlSnapshot(control, controlRead = null) {
  assertControl(control);
  let body = canonicalJson(control); let provenance = 'canonical_projection';
  if (controlRead !== null) {
    requireValid(controlRead?.body instanceof Uint8Array && object(controlRead.control)
      && sha.test(controlRead.sha256) && sha256Hex(controlRead.body) === controlRead.sha256,
    'original control read bytes/digest required');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(controlRead.body));
    requireValid(same(parsed, controlRead.control) && same(controlRead.control, control),
      'control read differs from inspected control');
    body = Buffer.from(controlRead.body); provenance = 'exact_read';
  }
  return assertControlSnapshot({ control_id: control.control_id, revision: control.revision,
    operation_id: control.operation_id, sha256: sha256Hex(body), byte_provenance: provenance,
    registered_change_ids: Object.keys(control.registered_changes).sort() });
}
