// A physical projection of ALREADY authenticated exact-leaf metadata. Exclude
// parent/shard references: unrelated siblings can legitimately change them.
// File identities remain conservative: repacking a shared file requires evidence.
import { canonicalJson, scopeKey, assertScope, assertIdentity } from './schema.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { evidence } from './limits.mjs';

export function assertInspectionScope(scope) {
  if (Object.hasOwn(scope, 'before') || Object.hasOwn(scope, 'after')) return assertScope(scope);
  evidence(Object.keys(scope).length === 2 && Object.hasOwn(scope, 'identity') && Object.hasOwn(scope, 'day_utc'),
    'invalid_scope', 'Inspection selection requires only physical identity and UTC day');
  assertIdentity(scope.identity);
  evidence(typeof scope.day_utc === 'string' && /^\d{4}-\d\d-\d\d$/.test(scope.day_utc)
    && Number.isFinite(Date.parse(`${scope.day_utc}T00:00:00.000Z`))
    && new Date(`${scope.day_utc}T00:00:00.000Z`).toISOString().slice(0, 10) === scope.day_utc,
  'invalid_scope', 'Valid UTC physical inspection day required');
  return scope;
}

export function physicalScopeDigest(scope, leaf) {
  return physicalScopeDigestForKey(scope, leaf, scopeKey(scope));
}

// Shared byte-stable projection only. Each caller supplies its own validated
// identity/key boundary; currentness retains its receipt-only validation above.
export function physicalScopeDigestForKey(scope, leaf, physicalKey) {
  evidence(leaf?.timeseries_id === scope.identity.timeseries_id
    && leaf.connector_id === scope.identity.connector_id
    && leaf.pollutant_code === scope.identity.pollutant_code && leaf.day_utc === scope.day_utc
    && Array.isArray(leaf.files) && Array.isArray(leaf.segments),
  'invalid_physical_scope_authority', 'Exact leaf does not describe the requested physical scope');
  return sha256Hex(canonicalJson({ scope_key: physicalKey,
    history_schema_version: leaf.history_schema_version, writer_version: leaf.writer_version,
    physical_layout_version: leaf.physical_layout_version,
    row_count: leaf.row_count, min_observed_at_utc: leaf.min_observed_at_utc,
    max_observed_at_utc: leaf.max_observed_at_utc,
    files: leaf.files, segments: leaf.segments }));
}
