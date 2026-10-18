// Private, unverified Prune source evidence. Nothing in this module creates a
// verified-change receipt, registers control state, or grants publication authority.
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { computePruneConnectorSourceIdentity, comparePruneConnectorSourceIdentities } from '../../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { PRUNE_PENDING_SOURCE_LIMITS as LIMITS, evidence } from './limits.mjs';
import { describePrunePendingSource } from './prune-evidence.mjs';
import { canonicalJson } from './schema.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function validatePrunePendingSourceRows(bytes, { dayUtc, connectorId, expectedRowCount, sourceIdentity }) {
  evidence(bytes.length > 0 && bytes.at(-1) === 10, 'invalid_frozen_source', 'frozen source must end in a newline');
  const rows = [];
  const scopes = new Set();
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').slice(0, -1)) {
    evidence(line.length > 0, 'invalid_frozen_source', 'blank frozen source row');
    const row = JSON.parse(line);
    evidence(row.connector_id === connectorId && row.observed_at_utc?.slice(0, 10) === dayUtc,
      'invalid_frozen_source', 'frozen source row has wrong connector or UTC day');
    rows.push(row);
    evidence(rows.length <= LIMITS.rows, 'resource_limit', 'frozen source exceeds JSONgen row limit');
    scopes.add(`${row.connector_id}:${row.timeseries_id}:${row.station_id}:${row.pollutant_code}:${dayUtc}`);
    evidence(scopes.size <= LIMITS.scopes, 'resource_limit', 'frozen source exceeds JSONgen scope limit');
  }
  evidence(rows.length === expectedRowCount && rows.length > 0, 'invalid_frozen_source', 'frozen source row count changed');
  evidence(comparePruneConnectorSourceIdentities(computePruneConnectorSourceIdentity(rows), sourceIdentity).match,
    'invalid_frozen_source', 'frozen source content identity changed');
  return rows;
}

export function preparePrunePendingSource({ path, runId, dayUtc, connectorId, expectedRowCount, sourceIdentity }) {
  evidence(UUID.test(runId) && DAY.test(dayUtc) && Number.isSafeInteger(connectorId) && connectorId > 0,
    'invalid_frozen_source', 'invalid Prune invocation or connector-day identity');
  evidence(Number.isSafeInteger(expectedRowCount) && expectedRowCount > 0,
    'invalid_frozen_source', 'invalid expected row count');
  evidence(expectedRowCount <= LIMITS.rows,
    'resource_limit', 'complete connector-day exceeds JSONgen row limit');
  const size = fs.statSync(path).size;
  evidence(size > 0 && size <= LIMITS.uncompressed_bytes,
    'resource_limit', 'frozen source exceeds JSONgen uncompressed byte limit');
  const source = fs.readFileSync(path);
  evidence(source.length === size, 'invalid_frozen_source', 'frozen source size changed during read');
  const rows = validatePrunePendingSourceRows(source,
    { dayUtc, connectorId, expectedRowCount, sourceIdentity });
  const compressed = gzipSync(source, { mtime: 0 });
  evidence(compressed.length <= LIMITS.compressed_bytes,
    'resource_limit', 'frozen source exceeds JSONgen compressed byte limit');
  const evidenceEnvelope = describePrunePendingSource({ source, compressed, rows,
    runId, dayUtc, connectorId, sourceIdentity });
  evidence(canonicalJson(evidenceEnvelope).length <= LIMITS.evidence_bytes,
    'resource_limit', 'complete connector-day exceeds JSONgen source evidence limit');
  return { body: compressed, evidence: evidenceEnvelope, compressed_sha256: sha256Hex(compressed),
    compressed_byte_size: compressed.length, uncompressed_sha256: sha256Hex(source),
    uncompressed_byte_size: source.length };
}
