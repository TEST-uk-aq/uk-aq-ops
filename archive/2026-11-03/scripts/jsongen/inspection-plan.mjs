import { canonicalJson, scopeKey } from './schema.mjs';
import { assertInspectionScope } from './scope-authority.mjs';
import { LIMITS, PRUNE_PENDING_SOURCE_LIMITS, evidence } from './limits.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { observationHistoryIndexV3RangeForTimeseriesId } from '../../workers/shared/uk_aq_observation_history_index_v3.mjs';
import { timeseriesBindingSourceRangeManifestKey } from '../backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs';

export function planInspection(scopes, partitionIndex = 0, partitionSize = LIMITS.scopes) {
  evidence(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= PRUNE_PENDING_SOURCE_LIMITS.scopes,
    'resource_limit', 'Inspection accounts for at most 1,024 physical scopes');
  scopes.forEach(assertInspectionScope);
  const scopeKeys = scopes.map(scopeKey).sort();
  evidence(new Set(scopeKeys).size === scopeKeys.length && Number.isSafeInteger(partitionSize)
    && partitionSize > 0 && partitionSize <= LIMITS.scopes, 'invalid_scope', 'Duplicate scope or invalid inspection partition');
  const partitions = [];
  for (let i = 0; i < scopeKeys.length; i += partitionSize) {
    const keys = scopeKeys.slice(i, i + partitionSize);
    partitions.push({ partition_index: partitions.length, scope_keys: keys,
      membership_sha256: sha256Hex(canonicalJson(keys)) });
  }
  evidence(Number.isSafeInteger(partitionIndex) && partitionIndex >= 0 && partitionIndex < partitions.length,
    'invalid_inspection_partition', 'Requested inspection partition is outside the complete scope set');
  return { partition_size: partitionSize, partition_count: partitions.length, total_scope_count: scopeKeys.length,
    scope_set_sha256: sha256Hex(canonicalJson(scopeKeys)), partitions, selected_partition: partitionIndex,
    selected_scope_keys: partitions[partitionIndex].scope_keys,
    cross_invocation_consistency: 'not_established_do_not_merge_as_one_snapshot' };
}

// Upper bound from actual deterministic key names, not a global GET multiplier.
// A selected immutable overlay manifest cannot be named until latest is read;
// reserve one such object per connector, although unsupported transitions fail closed.
export function planMetadataRequests(scopes, generation) {
  const keys = new Set(), connectors = new Set();
  const base = generation.observations_prefix, index = generation.observations_timeseries_index_prefix;
  const binding = generation.timeseries_binding_index_prefix;
  for (const scope of scopes) {
    const d = scope.day_utc, id = scope.identity, suffix = `day_utc=${d}/connector_id=${id.connector_id}/pollutant_code=${id.pollutant_code}`;
    const range = observationHistoryIndexV3RangeForTimeseriesId(id.timeseries_id);
    const name = `${String(range.range_start).padStart(6, '0')}-${String(range.range_end).padStart(6, '0')}`;
    [generation.observations_root_key,
      `${base}/_manifests/year=${d.slice(0, 4)}/manifest.json`,
      `${base}/_manifests/year=${d.slice(0, 4)}/month=${d.slice(5, 7)}/manifest.json`,
      `${base}/day_utc=${d}/manifest.json`, `${base}/day_utc=${d}/connector_id=${id.connector_id}/manifest.json`,
      `${base}/${suffix}/manifest.json`, `${index}/${suffix}/manifest.json`, `${index}/_aligned/${suffix}/manifest.json`,
      `${index}/${suffix}/timeseries_id=${String(id.timeseries_id).padStart(9, '0')}.json`,
      `${index}/_aligned/${suffix}/range=${name}.json`, `${binding}/_manifests/root.json`,
      `${binding}/_source_state.json`, `${binding}/_manifests/_refresh_state.json`,
      timeseriesBindingSourceRangeManifestKey(binding, Math.floor(id.timeseries_id / 1000) * 1000),
      `${binding}/timeseries_id=${id.timeseries_id}.json`, 'history/_index_v3/verification/latest.json'].forEach(key => keys.add(key));
    connectors.add(id.connector_id);
  }
  return { deterministic_keys: [...keys].sort(), status_manifest_allowance: connectors.size,
    initial_get_allowance: keys.size + connectors.size,
    metadata_get_allowance: 2 * (keys.size + connectors.size) + 1 };
}
