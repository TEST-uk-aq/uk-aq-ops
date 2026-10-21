// Original AURN evidence identity, independent of the monthly receipt allow-list.
// Syntax is admission only; the original reader must prove source/publication/
// before/binding membership before any identity is authenticated.
import { evidence } from './limits.mjs';
import { physicalScopeDigestForKey } from './scope-authority.mjs';

export function assertPruneOriginalIdentity(identity) {
  evidence(identity && typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).length === 4
    && ['connector_id', 'timeseries_id', 'station_id', 'pollutant_code'].every(k => Object.hasOwn(identity, k))
    && identity.connector_id === 1
    && Number.isSafeInteger(identity.timeseries_id) && identity.timeseries_id > 0
    && Number.isSafeInteger(identity.station_id) && identity.station_id > 0
    && typeof identity.pollutant_code === 'string' && /^[a-z0-9_]+$/.test(identity.pollutant_code),
  'invalid_original_scope_authority', 'Original AURN physical identity is invalid');
  return identity;
}

export function pruneOriginalPhysicalKey(scope) {
  const identity = assertPruneOriginalIdentity(scope.identity ?? {
    connector_id: scope.connector_id === undefined ? 1 : scope.connector_id, timeseries_id: scope.timeseries_id,
    station_id: scope.station_id, pollutant_code: scope.pollutant_code });
  const day = scope.day_utc;
  evidence(typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day)
    && Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
    && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day,
  'invalid_original_scope_authority', 'Original AURN UTC scope day is invalid');
  // Preserve the established supported-scope encoding, without monthKey().
  return `${identity.connector_id}:${identity.timeseries_id}:${identity.station_id}:${identity.pollutant_code}:${day.slice(0, 7)}:${day}`;
}

export function pruneOriginalPhysicalDigest(scope, leaf) {
  return physicalScopeDigestForKey(scope, leaf, pruneOriginalPhysicalKey(scope));
}
