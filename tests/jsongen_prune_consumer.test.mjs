// Focused admission/coverage/replay boundary checks. No network, canonical
// reads, database execution, signing or operational object writes occur here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonicalJson, CONTROL_KEY, ORDERING_BLOCKER, assertControl, assertReceipt, assertPruneReceiptGroup } from '../scripts/jsongen/schema.mjs';
import { sha256Hex } from '../workers/shared/r2_sigv4.mjs';
import { connectPruneOutboxReader, originalPruneAcceptance } from '../scripts/jsongen/prune-outbox-reader.mjs';
import { authenticatePruneHandover, inspectAuthenticatedPruneHandover,
  assertPruneReceiptScopeEligibility } from '../scripts/jsongen/prune-consumer-authentication.mjs';
import { planPruneScopePartitions } from '../scripts/jsongen/prune-consumer-partitions.mjs';
import { consumePruneAcceptance, runPruneConsumer } from '../scripts/jsongen/prune-consumer.mjs';
import { buildPruneReceiptGroup, inspectPruneReceiptGroup } from '../scripts/jsongen/prune-receipts.mjs';
import { decodePruneMetadataEvidence, compactPruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { updateManagedControl, selectManagedPublications } from '../scripts/jsongen/control.mjs';
import { reconcileManagedInputs } from '../scripts/jsongen/reconcile.mjs';
import { managedR2ReadConfig } from '../scripts/jsongen/r2-config.mjs';
import { JSONgenEvidenceError } from '../scripts/jsongen/limits.mjs';

const run = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb'; const day = '2026-10-10';
const key = { environment: 'TEST', writer_identity: 'prune_daily_v3', run_id: run,
  attempt_id: run, day_utc: day, connector_id: 1 };
const env = { UK_AQ_ENV_NAME: 'TEST', UK_AQ_GITHUB_REPO: 'fixture-org/fixture-ops',
  SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co',
  UK_AQ_JSONGEN_PRUNE_READER_DB_URL: 'postgresql://reader:fixture@db.aaaaaaaaaaaaaaaaaaaa.supabase.co/postgres' };

import { sourceAndOriginalEvent } from './jsongen_prune_consumer_fixture.mjs';

test('complete original source with a non-Stage-1 pollutant fails with a structured scope code', () => {
  const scope = pollutant_code => ({ pollutant_code, timeseries_id: 1, station_id: 1, day_utc: day, row_count: 1 });
  assert.doesNotThrow(() => assertPruneReceiptScopeEligibility({ scope: {
    physical_timeseries_days: [scope('pm25'), scope('pm10'), scope('no2')] } }));
  assert.throws(() => assertPruneReceiptScopeEligibility({ scope: {
    physical_timeseries_days: [scope('pm25'), scope('o3')] } }), { code: 'unsupported_receipt_scope' });
});

test('consumer reports only bounded failure stage and exception class', async () => {
  const derivedR2 = managedR2ReadConfig({ UK_AQ_ENV_NAME: 'TEST',
    UK_AQ_JSONGEN_R2_ENDPOINT: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com',
    UK_AQ_JSONGEN_R2_BUCKET: 'fixture-derived-bucket',
    UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID: 'fixture-read',
    UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY: 'fixture-secret' });
  const secret = 'private-row-value-and-url';
  let result = await consumePruneAcceptance({ key, derivedR2,
    reader: { read: async () => { throw Object.assign(new TypeError(secret), { attempted: { secret } }); } } });
  assert.equal(result.state, 'reconciliation_required');
  assert.equal(result.reason, 'consumer_boundary_rejected');
  assert.equal(result.failure_stage, 'original_outbox_read');
  assert.equal(result.error_class, 'unexpected_type_error');
  assert.equal(result.receipt_eligible, false);
  assert.equal(result.receipt_retention, 'not_attempted');
  assert.doesNotMatch(JSON.stringify(result), /private-row-value-and-url/);
  result = await consumePruneAcceptance({ key, derivedR2,
    reader: { read: async () => { throw new JSONgenEvidenceError('outbox_read_unavailable', 'Read-only outbox unavailable'); } } });
  assert.equal(result.reason, 'outbox_read_unavailable');
  assert.equal(result.failure_stage, 'original_outbox_read');
  assert.equal(result.error_class, 'evidence_error');
});

test('independent compressed original authority yields eight strict 128-scope receipts; read mode never writes or publishes', async () => {
  const f = await sourceAndOriginalEvent(); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
  try {
    const acceptance = await reader.read(key);
    const proof = await authenticatePruneHandover({ acceptance, derivedR2: f.r2 });
    const p = planPruneScopePartitions({ handover: proof });
    const group = inspectPruneReceiptGroup(buildPruneReceiptGroup({ handover: proof }));
    assertPruneReceiptGroup(group.entries.map(e => e.receipt));
    for (const { receipt } of group.entries) {
      assertReceipt(receipt); assert.equal(receipt.schema_version, 2);
      assert.equal(receipt.durability.retained_receipt_authority.relation, 'uk_aq_ops.prune_jsongen_gate_acceptance_outbox');
      assert.equal(receipt.source.binding_authority.key, 'history/_index_v3/timeseries_binding/_manifests/root.json');
      assert.ok(receipt.scopes.every(s => s.before.state === 'authoritative_empty' && s.before.row_count === 0));
    }
    assert.throws(() => assertPruneReceiptGroup(group.entries.slice(1).map(e => e.receipt)), /missing|incomplete/);
    assert.equal(p.partition_count, 8); assert.equal(p.physical_scope_count, 1024); assert.equal(p.observation_count, 2048);
    assert.deepEqual(planPruneScopePartitions({ handover: proof }), p);
    assert.ok(p.partitions.every(p => p.scope_count === 128 && p.row_count === 256));
    assert.equal(new Set(p.partitions.flatMap(p => p.binding.scopes.map(s => s.timeseries_id))).size, 1024);
    assert.equal(new Set(p.partitions.map(p => p.change_id)).size, 8);
    assert.deepEqual(p.partitions.flatMap(p => p.binding.scopes).map(s => s.verification_status_counts)
      .reduce((a, c) => ({ P: a.P + c.P, R: a.R + c.R, null: a.null + c.null }), { P: 0, R: 0, null: 0 }),
    { P: 684, R: 682, null: 682 });
    const result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2 });
    assert.equal(result.state, 'authenticated_read_only'); assert.equal(result.receipt_eligible, false);
    assert.equal(result.registration, 'not_attempted'); assert.equal(result.handover_complete, false);
    assert.deepEqual(result.missing_authority, []);
    assert.equal(inspectAuthenticatedPruneHandover(proof).result.publication_eligible, false);
    assert.equal(f.objects.size, 1); assert.throws(selectManagedPublications);
    const registered = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain', initializeControl: true });
    assert.equal(registered.state, 'registered'); assert.equal(registered.handover_complete, true);
    const control = assertControl(JSON.parse(f.objects.get(CONTROL_KEY)));
    assert.equal(Object.keys(control.registered_changes).length, 8);
    assert.equal(Object.values(control.registered_changes).reduce((n, e) => n + e.receipt.bundle.row_count, 0), 2048);
  } finally { await reader.close(); }
  const invalid = await sourceAndOriginalEvent(1, { aliasMismatch: true });
  const invalidReader = await connectPruneOutboxReader({ env, Client: invalid.Client });
  try {
    const result = await consumePruneAcceptance({ reader: invalidReader, key, derivedR2: invalid.r2 });
    assert.equal(result.reason, 'invalid_frozen_source');
  } finally { await invalidReader.close(); }
});

test('caller references, missing original bytes, tampered private bytes and source membership fail closed', async () => {
  assert.throws(() => originalPruneAcceptance({ ...key, verified: true }), { code: 'unauthenticated_original_outbox' });
  await assert.rejects(runPruneConsumer([], { env }), { code: 'invalid_consumer_arguments' });
  const f = await sourceAndOriginalEvent(2); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
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
  const f = await sourceAndOriginalEvent(1); const reader = await connectPruneOutboxReader({ env, Client: f.Client });
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

test('legacy codec, marker disagreement and contradictory original lock/before/Core authority fail before writes', async () => {
  const f = await sourceAndOriginalEvent(2), reader = await connectPruneOutboxReader({ env, Client: f.Client });
  const original = JSON.parse(f.row.final_evidence_bytes);
  try {
    for (const mutate of [
      e => { delete e.original_metadata_evidence; e.original_metadata_snapshot.schema_version = 1; },
      e => { e.original_metadata_evidence.bytes_base64 = 'AAAA' + e.original_metadata_evidence.bytes_base64.slice(4); },
      e => { e.original_metadata_snapshot.evidence_sha256 = '0'.repeat(64); },
      e => { const d = decodePruneMetadataEvidence(e); d.original_authority_extension.lock.run_id = randomUUID(); Object.assign(e, d); compactPruneMetadataEvidence(e); },
      e => { const d = decodePruneMetadataEvidence(e); d.original_authority_extension.before.scopes.pop(); Object.assign(e, d); compactPruneMetadataEvidence(e); },
      e => { const d = decodePruneMetadataEvidence(e); d.original_authority_extension.binding.source_fingerprint = '0'.repeat(64); Object.assign(e, d); compactPruneMetadataEvidence(e); },
    ]) {
      const e = structuredClone(original); mutate(e); f.setEnvelope(e);
      const result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain' });
      assert.equal(result.state, 'reconciliation_required'); assert.equal(result.handover_complete, false);
      assert.equal(f.objects.size, 1);
    }
  } finally { await reader.close(); }
});

test('partial partition retention is replayable and never registers an arbitrary subset', async () => {
  const f = await sourceAndOriginalEvent(129), reader = await connectPruneOutboxReader({ env, Client: f.Client }); let receipts = 0;
  f.setHook(args => { if (args.key.includes('/receipts/') && ++receipts === 2) throw new Error('lost response before storage'); });
  try {
    let result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain', initializeControl: true });
    assert.equal(result.handover_complete, false); assert.equal(result.reason, 'ambiguous_r2_write_outcome');
    assert.equal(f.objects.has(CONTROL_KEY), false);
    const expected = result.expected_receipts;
    f.setHook(null);
    result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain', initializeControl: true });
    assert.equal(result.state, 'registered'); assert.equal(result.handover_complete, true);
    assert.deepEqual(result.expected_receipts, expected);
    const control = assertControl(JSON.parse(f.objects.get(CONTROL_KEY)));
    assert.equal(Object.keys(control.registered_changes).length, 2);
    const incomplete = structuredClone(control); delete incomplete.registered_changes[expected[0].change_id];
    assert.throws(() => assertControl(incomplete), /missing|incomplete/);
    const replay = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain' });
    assert.equal(replay.registration_outcome, 'already_retained'); assert.equal(replay.control_operation.revision, control.revision);
    await assert.rejects(updateManagedControl({ r2: f.r2, command: { type: 'retain_receipt',
      ...Object.values(control.registered_changes)[0] } }), /complete atomic/);
  } finally { await reader.close(); }
});

test('ambiguous immutable/control writes and CAS conflicts resolve without losing unrelated registered changes', async () => {
  const f = await sourceAndOriginalEvent(2), other = await sourceAndOriginalEvent(1, { runId: randomUUID(), dayUtc: '2026-10-11' });
  for (const [k, v] of other.objects) f.objects.set(k, v);
  const reader = await connectPruneOutboxReader({ env, Client: f.Client }), otherReader = await connectPruneOutboxReader({ env, Client: other.Client });
  try {
    assert.equal((await consumePruneAcceptance({ reader: otherReader, key: other.key, derivedR2: f.r2,
      mode: 'retain', initializeControl: true })).state, 'registered');
    let conflict = true, ambiguous = true;
    f.setHook(args => {
      if (args.key === CONTROL_KEY && conflict) {
        conflict = false; const old = f.objects.get(CONTROL_KEY), current = JSON.parse(old);
        current.previous = { revision: current.revision, operation_id: current.operation_id, sha256: sha256Hex(old) };
        current.revision++; current.operation_id = randomUUID(); current.updated_at_utc = new Date().toISOString();
        current.failure = { code: ORDERING_BLOCKER, state: 'reconcile_required', at_utc: current.updated_at_utc, detail: 'unrelated concurrent state' };
        f.objects.set(CONTROL_KEY, canonicalJson(assertControl(current))); return { status: 412 };
      }
      if (ambiguous && args.key !== CONTROL_KEY) { ambiguous = false; f.objects.set(args.key, Buffer.from(args.body)); throw new Error('lost immutable response'); }
      if (args.key === CONTROL_KEY && !conflict) { f.objects.set(args.key, Buffer.from(args.body)); throw new Error('lost control response'); }
    });
    const result = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain' });
    assert.equal(result.state, 'registered'); assert.equal(result.registration_outcome, 'confirmed_after_ambiguous_write');
    const control = assertControl(JSON.parse(f.objects.get(CONTROL_KEY)));
    assert.equal(Object.keys(control.registered_changes).length, 2); assert.equal(control.failure.detail, 'unrelated concurrent state');
    f.objects.set(result.expected_receipts[0].bundle.key, Buffer.from('conflicting bytes'));
    const rejected = await consumePruneAcceptance({ reader, key, derivedR2: f.r2, mode: 'retain' });
    assert.equal(rejected.reason, 'ambiguous_r2_write_outcome'); assert.equal(rejected.handover_complete, false);
  } finally { await reader.close(); await otherReader.close(); }
});

test('reconciliation reauthenticates original receipts and fails closed when original recovery input disappears', async () => {
  const f = await sourceAndOriginalEvent(2), reader = await connectPruneOutboxReader({ env, Client: f.Client });
  try {
    assert.equal((await consumePruneAcceptance({ reader, key, derivedR2: f.r2,
      mode: 'retain', initializeControl: true })).state, 'registered');
    const control = assertControl(JSON.parse(f.objects.get(CONTROL_KEY)));
    const options = { derivedR2: f.r2, control };
    let report = await reconcileManagedInputs(options);
    assert.equal(report.changes[0].authentication.authenticated, false);
    report = await reconcileManagedInputs({ ...options, pruneReader: reader });
    assert.equal(report.changes[0].authentication.state, 'original_prune_event_authenticated');
    assert.equal(report.changes[0].authentication.authenticated, true);
    assert.equal(report.complete_change_coverage, false); assert.equal(report.publication_selection, 'disabled');
    const pending = Object.values(control.registered_changes)[0].receipt.origin.pending_source;
    f.objects.delete(pending.key);
    report = await reconcileManagedInputs({ ...options, pruneReader: reader });
    assert.equal(report.changes[0].authentication.authenticated, false);
    assert.equal(report.state, 'reconciliation_required');
    assert.ok(report.changes[0].diagnostics.some(d => d.detail.startsWith('Original event/private source authentication failed')));
  } finally { await reader.close(); }
});
