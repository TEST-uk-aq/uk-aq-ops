// Focused admission/coverage/replay boundary checks. No network, canonical
// reads, database execution, signing or object writes occur in these checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonicalJson, BUCKET } from '../scripts/jsongen/schema.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { describePrunePendingSource } from '../scripts/jsongen/prune-evidence.mjs';
import { preparePruneOriginalFinalEvidence } from '../scripts/jsongen/prune-final-evidence.mjs';
import { createPruneOriginalMetadataCapture, preparePruneOriginalMetadataSnapshot } from '../scripts/jsongen/prune-original-metadata.mjs';
import { connectPruneOutboxReader, originalPruneAcceptance } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover } from '../scripts/jsongen/prune-consumer-authentication.mjs';
import { planPruneScopePartitions } from '../scripts/jsongen/prune-consumer-partitions.mjs';
import { consumePruneAcceptance, runPruneConsumer } from '../scripts/jsongen/prune-consumer.mjs';

const run = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb'; const day = '2026-10-10';
const key = { environment: 'TEST', writer_identity: 'prune_daily_v3', run_id: run,
  attempt_id: run, day_utc: day, connector_id: 1 };
const env = { UK_AQ_ENV_NAME: 'TEST', SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres' };

function sourceAndOriginalEvent(scopes = 1024, { aliasMismatch = false } = {}) {
  const rows = Array.from({ length: scopes }, (_, i) => ({ connector_id: 1, station_id: i + 1,
    timeseries_id: i + 1, pollutant_code: 'pm25', observed_at_utc: `${day}T01:02:03.004Z`,
    observed_at: `${day}T01:02:03.${aliasMismatch ? '005' : '004'}Z`, value: 1.2345678901234567,
    verification_status: ['P', 'R', null][i % 3] })).flatMap(row => [row, { ...row }]);
  const source = Buffer.concat(rows.map(canonicalJson)); const compressed = gzipSync(source, { mtime: 0 });
  const sourceIdentity = computePruneConnectorSourceIdentity(rows);
  const object = { bucket: BUCKET, key: `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=1/day_utc=${day}`
    + `/invocation=${run}/compressed_sha256=${sha256Hex(compressed)}/uncompressed_sha256=${sha256Hex(source)}.ndjson.gz`,
  sha256: sha256Hex(compressed), byte_size: compressed.length, json_sha256: sha256Hex(source), json_byte_size: source.length };
  const intent = createHash('sha256').update(JSON.stringify(['uk_aq_jsongen_upload_intent_v1', BUCKET, object.key,
    'prune_daily_v3', run, 'v3', 1, day, 'connector_day_observations_ndjson_gzip', object.byte_size, object.sha256,
    object.json_byte_size, object.json_sha256, 'connector_day', 1, day])).digest('hex');
  const unsigned = describePrunePendingSource({ source, compressed, rows, runId: run, dayUtc: day, connectorId: 1, sourceIdentity });
  const description = { ...unsigned, signed_upload: { intent_id: intent, object, disposition: 'put_acknowledged_unverified' } };
  const pending = { state: 'put_acknowledged_unverified', intent_id: intent, source: object, pending_evidence: description,
    source_evidence_sha256: sha256Hex(canonicalJson(unsigned)), preparation_sha256: sha256Hex(canonicalJson(description)) };
  const capture = createPruneOriginalMetadataCapture();
  const metadata = (key, value) => {
    const body = canonicalJson(value); capture.recordPublishedObject({ key, body });
    return { key, sha256: sha256Hex(body), byte_size: body.length, verified: true, durable: true };
  };
  const base = `history/v3/observations/day_utc=${day}/connector_id=1`;
  const counts = Object.fromEntries(unsigned.scope.physical_timeseries_days.map(s => [s.timeseries_id, s.row_count]));
  const partition = unsigned.scope.pollutant_partitions[0];
  const file = { key: `${base}/pollutant_code=pm25/part-0.parquet`, row_count: rows.length,
    bytes: 100, etag_or_hash: 'd'.repeat(64), timeseries_row_counts: counts };
  const child = { ...partition, connector_id: 1, day_utc: day, manifest_key: `${base}/pollutant_code=pm25/manifest.json`,
    manifest_hash: 'b'.repeat(64), timeseries_row_counts: counts, files: [file] };
  const childRef = metadata(child.manifest_key, child);
  const manifest = { history_version: 'v2', connector_id: 1, day_utc: day, manifest_key: `${base}/manifest.json`,
    manifest_hash: 'a'.repeat(64), source_row_count: rows.length, file_count: 1, total_bytes: 100,
    pollutant_manifests: [{ manifest_key: child.manifest_key, manifest_hash: child.manifest_hash }] };
  const connectorRef = metadata(manifest.manifest_key, manifest);
  const index = metadata(`history/_index_v3/observations_timeseries/day_utc=${day}/connector_id=1/pollutant_code=pm25/manifest.json`,
    { index_generation: 'v3', connector_id: 1, day_utc: day, pollutant_code: 'pm25', history_schema_version: 3,
      writer_version: 'parquet-wasm-zstd-v3', leaves_by_timeseries_id: Object.fromEntries(Object.keys(counts).map(k => [k, []])) });
  const d = metadata(`history/v3/observations/day_utc=${day}/manifest.json`, { day_utc: day });
  const aggregate = metadata('history/v3/observations/_manifests/manifest.json', { kind: 'original_verified_aggregate' });
  const latest = metadata('history/_index_v3/observations_timeseries_latest.json', { index_generation: 'v3' });
  const pin = r => ({ key: r.key, sha256: r.sha256, byte_size: r.byte_size });
  const connector = { manifest_key: manifest.manifest_key, manifest_hash: manifest.manifest_hash,
    run_id: run, day_utc: day, connector_id: 1, source_row_count: rows.length, file_count: 1, total_bytes: 100,
    connector_manifest: { ...pin(connectorRef), bucket: 'canonical-test' },
    pollutant_manifests: [{ ...partition, manifest: { ...pin(childRef), bucket: 'canonical-test', semantic_manifest_hash: child.manifest_hash },
      files: [{ key: file.key, row_count: file.row_count, byte_size: file.bytes, sha256: file.etag_or_hash, timeseries_row_counts: counts }] }],
    scoped_roots: [{ scope: { day_utc: day, connector_id: 1, pollutant_code: 'pm25' }, reference: pin(index) }] };
  const snapshot = preparePruneOriginalMetadataSnapshot({ capture, bucket: 'canonical-test', dayUtc: day, connectorId: 1,
    runId: run, writerGitSha: '4'.repeat(40), canonicalReferences: [connectorRef, childRef], exactReferences: [index],
    dayReferences: [d], affectedDaysUtc: [day], aggregateReferences: [aggregate], latestReferences: [latest] });
  const prepared = preparePruneOriginalFinalEvidence({ pending, connector, runId: run, dayUtc: day, connectorId: 1,
    writerGitSha: '4'.repeat(40), sourceIdentity, originalMetadataSnapshot: snapshot,
    finalization: { ok: true, affected_days_utc: [day], day_results: [{ day_utc: day, day_manifest: d }],
      canonical_aggregate_result: { canonical_aggregate_authority_verified: true, parent_state_reread_under_lock: true,
        affected_days_utc: [day], aggregate_manifests: [aggregate] },
      v3_publication: { exact_scopes: [{ ok: true }], latest_global: { ok: true, objects: [latest] } } } });
  const row = { ...key, event_schema_version: 1, writer_git_sha: '4'.repeat(40), accepted_at: '2026-10-10T02:00:00.123456Z',
    ...sourceIdentity, history_manifest_key: manifest.manifest_key, history_manifest_hash: manifest.manifest_hash,
    history_row_count: rows.length, history_file_count: 1, history_total_bytes: 100,
    gate_history_completed_at: '2026-10-10T02:00:00.000Z', gate_completion_source: 'prune_daily_phase_b',
    candidate_ready_marker: 'PRUNE_FIRST_DELETE_READY:v1', connector_manifest_byte_sha256: connectorRef.sha256,
    connector_manifest_byte_size: connectorRef.byte_size, pending_disposition: 'put_acknowledged_unverified',
    pending_intent_id: intent, pending_bucket: BUCKET, pending_object_key: object.key,
    pending_compressed_sha256: object.sha256, pending_compressed_byte_size: object.byte_size,
    pending_ndjson_sha256: object.json_sha256, pending_ndjson_byte_size: object.json_byte_size,
    original_source_status_provenance: 'original_source_status_unavailable', final_evidence_state: 'prepared_unverified',
    final_evidence_bytes: prepared.bytes, final_evidence_sha256: prepared.sha256, final_evidence_byte_size: prepared.byte_size };
  let body = compressed; const queries = []; let visible = true;
  class Client {
    async connect() {} async end() {}
    async query(sql, args) {
      queries.push({ sql, args });
      assert.doesNotMatch(sql, /history_candidates|prune_connector_day_gates/);
      if (sql.startsWith('SELECT current_setting')) return { rows: [{ read_only: true, default_read_only: true,
        restricted_role: true, reader_membership: true, reader_policy: true, can_read: true, can_mutate: false, can_accept: false }] };
      if (sql.includes('FROM uk_aq_ops.prune_jsongen_gate_acceptance_outbox')) return { rows: visible ? [{ ...row }] : [] };
      assert.match(sql, /^(BEGIN READ ONLY|COMMIT|ROLLBACK)$/); return { rows: [] };
    }
  }
  const r2 = { bucket: BUCKET, region: 'auto', endpoint: 'https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com',
    adapter: { async getObjectBounded({ key: requested }) {
      assert.equal(requested, object.key); assert.ok(!requested.endsWith('.parquet'));
      return { body, bytes: body.length };
    }, async putObjectConditional() { assert.fail('Incomplete authority must never write a bundle, receipt or control'); } } };
  return { Client, row, r2, queries, setVisible: value => { visible = value; }, setBody: value => { body = value; } };
}

test('independent original event and 1024 complete scopes yield eight stable plans, never VERIFIED or registration', async () => {
  const f = sourceAndOriginalEvent(); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  try {
    const acceptance = await reader.read(key);
    const proof = await authenticatePruneHandover({ acceptance, derivedR2: f.r2 });
    const p = planPruneScopePartitions({ handover: proof });
    assert.equal(p.partition_count, 8); assert.equal(p.physical_scope_count, 1024); assert.equal(p.observation_count, 2048);
    assert.deepEqual(planPruneScopePartitions({ handover: proof }), p);
    assert.ok(p.partitions.every(p => p.scope_count === 128 && p.row_count === 256));
    assert.equal(new Set(p.partitions.flatMap(p => p.binding.scopes.map(s => s.timeseries_id))).size, 1024);
    assert.equal(new Set(p.partitions.map(p => p.prospective_change_id)).size, 8);
    assert.deepEqual(p.partitions.flatMap(p => p.binding.scopes).map(s => s.verification_status_counts)
      .reduce((a, c) => ({ P: a.P + c.P, R: a.R + c.R, null: a.null + c.null }), { P: 0, R: 0, null: 0 }),
    { P: 684, R: 682, null: 682 });
    const result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2 });
    assert.equal(result.state, 'reconciliation_required'); assert.equal(result.receipt_eligible, false);
    assert.equal(result.registration, 'blocked_missing_original_authority'); assert.equal(result.handover_complete, false);
    assert.deepEqual(result.missing_authority.map(g => g.field), ['scopes[].before', 'source.binding_authority']);
    assert.equal(inspectAuthenticatedPruneHandover(proof).result.publication_eligible, false);
  } finally { await reader.close(); }
  const invalid = sourceAndOriginalEvent(1, { aliasMismatch: true });
  const invalidReader = await connectPruneOutboxReader({ env, Client: invalid.Client });
  try {
    const result = await consumePruneAcceptance({ reader: invalidReader, key, derivedR2: invalid.r2 });
    assert.equal(result.reason, 'invalid_frozen_source');
  } finally { await invalidReader.close(); }
});

test('caller references, missing original bytes, tampered private bytes and source membership fail closed', async () => {
  assert.throws(() => originalPruneAcceptance({ ...key, verified: true }), { code: 'unauthenticated_original_outbox' });
  await assert.rejects(runPruneConsumer([], { env }), { code: 'invalid_consumer_arguments' });
  const f = sourceAndOriginalEvent(2); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  try {
    const original = f.row.final_evidence_bytes;
    f.setBody(Buffer.from('corrupt'));
    let result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2 });
    assert.equal(result.reason, 'invalid_object_identity'); assert.equal(result.receipt_retention, 'not_attempted');
    f.row.final_evidence_state = 'not_captured'; f.row.final_evidence_bytes = null;
    result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2 });
    assert.equal(result.reason, 'missing_original_authority');
    f.row.final_evidence_state = 'prepared_unverified'; f.row.final_evidence_bytes = original;
    const envelope = JSON.parse(original); envelope.pending.source_evidence.scope.physical_timeseries_days.pop();
    const { signed_upload: _signed, ...unsigned } = envelope.pending.source_evidence;
    envelope.pending.source_evidence_sha256 = sha256Hex(canonicalJson(unsigned));
    envelope.pending.preparation_sha256 = sha256Hex(canonicalJson(envelope.pending.source_evidence));
    f.row.final_evidence_bytes = canonicalJson(envelope); f.row.final_evidence_sha256 = sha256Hex(f.row.final_evidence_bytes);
    f.row.final_evidence_byte_size = f.row.final_evidence_bytes.length;
    f.setBody(gzipSync(Buffer.concat(Array.from({ length: 2 }, (_, i) => ({ connector_id: 1, station_id: i + 1,
      timeseries_id: i + 1, pollutant_code: 'pm25', observed_at_utc: `${day}T01:02:03.004Z`, observed_at: `${day}T01:02:03.004Z`,
      value: 1.2345678901234567, verification_status: ['P', 'R'][i] })).flatMap(r => [r, { ...r }]).map(canonicalJson)), { mtime: 0 }));
    result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2 });
    assert.equal(result.reason, 'invalid_object_identity'); assert.equal(result.handover_complete, false);
  } finally { await reader.close(); }
});

test('late visibility is recovered by repeating a window; no discovery result acknowledges complete coverage', async () => {
  const f = sourceAndOriginalEvent(1); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const window = { from: '2026-10-10T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z', mode: 'resweep', limit: 1 };
  try {
    f.setVisible(false); assert.equal((await reader.discover(window)).events.length, 0);
    f.setVisible(true); const page = await reader.discover(window);
    assert.equal(page.events.length, 1); assert.equal(page.coverage_complete, false);
    assert.equal(page.state, 'replay_required');
    assert.match(f.queries.at(-2).sql, /ORDER BY accepted_at,run_id,attempt_id,day_utc,connector_id/);
    await assert.rejects(reader.discover({ ...window, after: { key, accepted_at: f.row.accepted_at,
      from: window.from, to: '2026-10-12T00:00:00.000Z', mode: window.mode } }), { code: 'invalid_discovery_window' });
    await assert.rejects(connectPruneOutboxReader({ env: { ...env, SUPABASE_DB_URL: env.UK_AQ_JSONGEN_PRUNE_READER_DB_URL }, Client: f.Client }),
      { code: 'reader_configuration_required' });
    class Elevated extends f.Client {
      async query(sql, args) {
        const result = await super.query(sql, args);
        if (sql.startsWith('SELECT current_setting')) result.rows[0].can_accept = true;
        return result;
      }
    }
    await assert.rejects(connectPruneOutboxReader({ env, Client: Elevated }), { code: 'reader_privilege_rejected' });
  } finally { await reader.close(); }
});
