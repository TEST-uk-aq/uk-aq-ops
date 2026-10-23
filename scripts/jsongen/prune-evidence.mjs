import { configuredEnvironment, isEnvironmentName } from './environment.mjs';
// Versioned, reproducible description of an early Prune source. It carries no
// final writer, gate, or current-canonical authority.
import { computeObservationContentHash } from '../../workers/shared/uk_aq_observation_content_hash.mjs';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';

const statusCounts = rows => ({
  P: rows.filter(row => row.verification_status === 'P').length,
  R: rows.filter(row => row.verification_status === 'R').length,
  null: rows.filter(row => row.verification_status === null).length,
});

export function describePrunePendingSource({ source, compressed, rows, runId, dayUtc,
  connectorId, sourceIdentity, environment = configuredEnvironment() }) {
  if (!isEnvironmentName(environment)) throw new TypeError('Invalid original source environment');
  const byPollutant = new Map();
  const byPhysicalScope = new Map();
  for (const row of rows) {
    const pollutant = row.pollutant_code;
    if (!byPollutant.has(pollutant)) byPollutant.set(pollutant, []);
    byPollutant.get(pollutant).push(row);
    const scopeKey = `${row.timeseries_id}:${row.station_id}:${pollutant}`;
    if (!byPhysicalScope.has(scopeKey)) byPhysicalScope.set(scopeKey, []);
    byPhysicalScope.get(scopeKey).push(row);
  }
  const partitions = [...byPollutant].sort(([a], [b]) => a.localeCompare(b))
    .map(([pollutantCode, partitionRows]) => {
      const hash = computeObservationContentHash(partitionRows);
      return {
        pollutant_code: pollutantCode,
        observation_content_hash: hash.observation_content_hash,
        observation_content_hash_contract_version: hash.observation_content_hash_contract_version,
        row_count: hash.observation_content_hash_row_count,
        verification_status_counts: hash.verification_status_counts,
      };
    });
  const physicalScopes = [...byPhysicalScope.values()].map(scopeRows => ({
    timeseries_id: scopeRows[0].timeseries_id,
    station_id: scopeRows[0].station_id,
    pollutant_code: scopeRows[0].pollutant_code,
    day_utc: dayUtc,
    row_count: scopeRows.length,
    verification_status_counts: statusCounts(scopeRows),
  })).sort((a, b) => a.pollutant_code.localeCompare(b.pollutant_code)
    || a.timeseries_id - b.timeseries_id || a.station_id - b.station_id);
  return {
    schema_version: 1,
    kind: 'uk_aq_jsongen_prune_pending_source_evidence',
    environment,
    writer: { identity: 'prune_daily_v3', invocation_id: runId, attempt_id: runId },
    index_generation: 'v3',
    connector_id: connectorId, day_utc: dayUtc,
    source_identity: { ...sourceIdentity },
    original_ndjson: { sha256: sha256Hex(source), byte_size: source.length, row_count: rows.length },
    compressed_ndjson_gzip: { sha256: sha256Hex(compressed), byte_size: compressed.length },
    scope: { kind: 'complete_connector_day', connector_id: connectorId, day_utc: dayUtc,
      pollutant_partitions: partitions, physical_timeseries_days: physicalScopes },
    original_source_status: {
      schema_version: 1,
      classification: 'original_source_status_unavailable',
      source_boundary: 'uk_aq_phase_b_history_compact_rows_v1.status',
      source_status: null,
      null_meaning: 'no_original_provider_status_asserted',
    },
    effective_verification_status: { representation: 'frozen_canonical_projection',
      authority_state: 'requires_original_final_canonical_publication_proof',
      counts: statusCounts(rows) },
    final_publication: { state: 'outstanding' },
  };
}
