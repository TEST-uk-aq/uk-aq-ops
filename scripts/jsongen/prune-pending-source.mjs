// Private, unverified Prune source evidence. Nothing in this module creates a
// verified-change receipt, registers control state, or grants publication authority.
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { r2GetObjectBounded, r2PutObjectConditional, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { computePruneConnectorSourceIdentity, comparePruneConnectorSourceIdentities } from '../../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { BUCKET, ROOT, canonicalJson } from './schema.mjs';
import { LIMITS, JSONgenEvidenceError, evidence } from './limits.mjs';
import { admitDerived } from './inputs.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function sourceRows(bytes, { dayUtc, connectorId, expectedRowCount, sourceIdentity }) {
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
  return rows.length;
}

export function preparePrunePendingSource({ path, runId, dayUtc, connectorId, expectedRowCount, sourceIdentity }) {
  evidence(UUID.test(runId) && DAY.test(dayUtc) && Number.isSafeInteger(connectorId) && connectorId > 0,
    'invalid_frozen_source', 'invalid Prune invocation or connector-day identity');
  evidence(Number.isSafeInteger(expectedRowCount) && expectedRowCount > 0,
    'invalid_frozen_source', 'invalid expected row count');
  const size = fs.statSync(path).size;
  evidence(size > 0 && size <= LIMITS.uncompressed_bytes,
    'resource_limit', 'frozen source exceeds JSONgen uncompressed byte limit');
  const source = fs.readFileSync(path);
  evidence(source.length === size, 'invalid_frozen_source', 'frozen source size changed during read');
  sourceRows(source, { dayUtc, connectorId, expectedRowCount, sourceIdentity });
  const compressed = gzipSync(source, { mtime: 0 });
  evidence(compressed.length <= LIMITS.compressed_bytes,
    'resource_limit', 'frozen source exceeds JSONgen compressed byte limit');
  const prefix = `${ROOT}/prune/pending/run_id=${runId}/day_utc=${dayUtc}/connector_id=${connectorId}`;
  const reference = {
    bucket: BUCKET, key: `${prefix}/${sha256Hex(compressed)}.ndjson.gz`,
    sha256: sha256Hex(compressed), byte_size: compressed.length,
    json_sha256: sha256Hex(source), json_byte_size: source.length,
  };
  const descriptor = {
    schema_version: 1, kind: 'uk_aq_jsongen_prune_pending_source',
    state: 'pending_unverified', selected_generation: 'v3',
    writer: { identity: 'prune_daily_v3', invocation_id: runId },
    candidate: { day_utc: dayUtc, connector_id: connectorId, expected_row_count: expectedRowCount },
    source_identity: sourceIdentity, source: reference,
    final_publication: null, gate_completion: null, receipt: null,
  };
  const descriptorBody = canonicalJson(descriptor);
  evidence(descriptorBody.length <= LIMITS.receipt_bytes, 'resource_limit', 'pending descriptor exceeds metadata limit');
  const descriptorReference = {
    bucket: BUCKET, key: `${prefix}/descriptor.${sha256Hex(descriptorBody)}.json`,
    sha256: sha256Hex(descriptorBody), byte_size: descriptorBody.length,
  };
  return { source: { body: compressed, reference }, descriptor: { body: descriptorBody, reference: descriptorReference } };
}

async function retainExact({ r2, object }) {
  const { body, reference } = object;
  try {
    await r2PutObjectConditional({ r2, key: reference.key, body,
      content_type: reference.key.endsWith('.gz') ? 'application/gzip' : 'application/json',
      sha256: reference.sha256, if_none_match: '*' });
  } catch (error) {
    if (!['R2_PRECONDITION_FAILED', 'R2_WRITE_AMBIGUOUS'].includes(error.code)) throw error;
  }
  try {
    const readback = await r2GetObjectBounded({ r2, key: reference.key, max_bytes: reference.byte_size });
    evidence(readback.bytes === reference.byte_size && sha256Hex(readback.body) === reference.sha256
      && Buffer.from(readback.body).equals(body), 'invalid_object_identity', 'immutable pending object differs');
  } catch (cause) {
    const error = new JSONgenEvidenceError('ambiguous_pending_source_retention',
      'Pending source readback unavailable; retain reference for reconciliation', cause);
    error.reference = reference;
    throw error;
  }
}

export async function retainPrunePendingSource({ r2, ...candidate }) {
  admitDerived(r2);
  const pending = preparePrunePendingSource(candidate);
  await retainExact({ r2, object: pending.source });
  await retainExact({ r2, object: pending.descriptor });
  return { source: pending.source.reference, descriptor: pending.descriptor.reference,
    state: 'pending_unverified' };
}
