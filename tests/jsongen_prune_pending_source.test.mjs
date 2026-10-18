import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { computePruneConnectorSourceIdentity } from '../workers/shared/uk_aq_prune_connector_source_identity.mjs';
import { BUCKET } from '../scripts/jsongen/schema.mjs';
import { preparePrunePendingSource } from '../scripts/jsongen/prune-pending-source.mjs';
import { uploadPrunePendingSource } from '../scripts/jsongen/prune-signed-upload.mjs';
import { preparePruneOriginalFinalEvidence } from '../scripts/jsongen/prune-final-evidence.mjs';
import { decodePruneMetadataEvidence } from '../scripts/jsongen/prune-metadata-codec.mjs';
import { describePruneGateOutboxEvidence, preparePrunePostCommitHandover } from '../scripts/jsongen/prune-outbox.mjs';
import { createPruneOriginalMetadataCapture, preparePruneOriginalMetadataSnapshot } from '../scripts/jsongen/prune-original-metadata.mjs';
import { canonicalJson } from '../scripts/jsongen/schema.mjs';
import { verifyPrunePendingSource } from '../scripts/jsongen/prune-pending-verification.mjs';
import signerWorker from '../workers/uk_aq_jsongen_signer/worker.mjs';
import { resolvePhaseBRuntimeConfig } from '../workers/uk_aq_prune_daily/phase_b_history_r2.mjs';

const runId = 'ca2a2ad8-c46c-4d65-9ee0-7147f03684eb';
const dayUtc = '2026-10-10';
const row = { connector_id: 1, station_id: 5, timeseries_id: 8, pollutant_code: 'pm25',
  observed_at: `${dayUtc}T01:02:03.004Z`, observed_at_utc: `${dayUtc}T01:02:03.004Z`,
  value: 1.23456789012345, verification_status: 'P' };
const signer = { endpoint: 'https://signer.test.example/v1/upload-intents',
  writerToken: 'w'.repeat(32), accessId: 'test-id', accessSecret: 'test-secret' };

function sampleOriginalMetadataSnapshot() {
  const capture = createPruneOriginalMetadataCapture();
  const entries = ['canonical', 'child', 'exact', 'day', 'aggregate', 'latest'].map(role => {
    const key = role === 'canonical'
      ? `history/v3/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`
      : `history/v3/observations/${role}.json`;
    const body = Buffer.from(`{  "role": "${role}" }\n`);
    const reference = { key, byte_size: body.byteLength, verified: true, durable: true,
      sha256: createHash('sha256').update(body).digest('hex') };
    capture.recordPublishedObject({ key, body });
    return { role, body, reference };
  });
  const args = { capture, bucket: 'uk-aq-test', dayUtc, connectorId: 1, runId,
    writerGitSha: '4'.repeat(40),
    canonicalReferences: [entries[0].reference, entries[1].reference],
    exactReferences: [entries[2].reference], dayReferences: [entries[3].reference],
    affectedDaysUtc: [dayUtc],
    aggregateReferences: [entries[4].reference], latestReferences: [entries[5].reference] };
  return { args, entries, snapshot: preparePruneOriginalMetadataSnapshot(args) };
}

async function fixtureAsync(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsongen-pending-'));
  try {
    const sourcePath = path.join(root, 'source.ndjson');
    const original = Buffer.from(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
    fs.writeFileSync(sourcePath, original);
    return await fn({ original, candidate: { path: sourcePath, runId, dayUtc, connectorId: 1,
      expectedRowCount: 2, sourceIdentity: computePruneConnectorSourceIdentity([row, row]) } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function signedIntent(request, change = {}) {
  const key = `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=1/day_utc=${dayUtc}`
    + `/invocation=${runId}/compressed_sha256=${request.compressed_sha256}`
    + `/uncompressed_sha256=${request.uncompressed_sha256}.ndjson.gz`;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const date = now.toISOString().replace(/[-:]/g, '').replace('.000', '');
  const upload = new URL(`https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com/${BUCKET}/${key}`);
  for (const [name, value] of Object.entries({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `fakeaccess/${date.slice(0, 8)}/auto/s3/aws4_request`,
    'X-Amz-Date': date, 'X-Amz-Expires': '60',
    'X-Amz-SignedHeaders': 'content-type;host;if-none-match;x-amz-checksum-sha256',
    'X-Amz-Signature': 'a'.repeat(64) })) upload.searchParams.set(name, value);
  return { intent_id: 'b'.repeat(64), state: 'signed_upload_intent',
    object: { bucket: BUCKET, key, sha256: request.compressed_sha256,
      byte_size: request.compressed_byte_size, json_sha256: request.uncompressed_sha256,
      json_byte_size: request.uncompressed_byte_size }, upload_url: upload.href,
    expires_at_utc: new Date(now.getTime() + 60_000).toISOString(),
    required_headers: { 'Content-Type': 'application/gzip', 'If-None-Match': '*',
      'x-amz-checksum-sha256': Buffer.from(request.compressed_sha256, 'hex').toString('base64') }, ...change };
}

test('handover defaults off and cannot enter v2; enabled TEST requires dedicated signer configuration', () => {
  assert.equal(resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3' }).jsongen_pending_source.enabled, false);
  assert.equal(resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v2',
    UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED: 'true' }).jsongen_pending_source.enabled, false);
  const enabled = resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3',
    UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED: 'true' }).jsongen_pending_source;
  assert.equal(enabled.enabled, true);
  assert.match(enabled.config_error, /TEST environment required/);
  const valid = resolvePhaseBRuntimeConfig({ UK_AQ_R2_HISTORY_VERSION: 'v3',
    UK_AQ_ENV_NAME: 'TEST', UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED: 'true',
    UK_AQ_JSONGEN_PRUNE_SIGNER_URL: signer.endpoint,
    UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN: signer.writerToken,
    UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID: signer.accessId,
    UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET: signer.accessSecret }).jsongen_pending_source;
  assert.deepEqual(valid.signer, signer);
  assert.equal(valid.config_error, undefined);
});

test('frozen duplicates and exact bytes are sent through one authenticated intent and signed PUT', async () => {
  await fixtureAsync(async ({ original, candidate }) => {
    const prepared = preparePrunePendingSource(candidate);
    assert.deepEqual(gunzipSync(prepared.body), original);
    assert.deepEqual(preparePrunePendingSource(candidate), prepared);
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return Response.json(signedIntent(JSON.parse(options.body)));
      return new Response(null, { status: 200 });
    };
    const result = await uploadPrunePendingSource({ signer, fetchImpl, ...candidate });
    assert.equal(result.state, 'put_acknowledged_unverified');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, signer.endpoint);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${signer.writerToken}`);
    assert.equal(calls[0].options.headers['CF-Access-Client-Secret'], signer.accessSecret);
    assert.deepEqual(calls[1].options.body, prepared.body);
    assert.equal(calls[1].options.headers['If-None-Match'], '*');
    assert.equal(result.source.json_sha256, prepared.uncompressed_sha256);
    assert.equal(result.pending_evidence.original_source_status.classification,
      'original_source_status_unavailable');
    assert.equal(result.pending_evidence.original_source_status.source_status, null);
    assert.deepEqual(result.pending_evidence.effective_verification_status.counts,
      { P: 2, R: 0, null: 0 });
    assert.equal(result.pending_evidence.scope.physical_timeseries_days[0].row_count, 2);
    assert.equal(result.pending_evidence.signed_upload.intent_id, result.intent_id);
    assert.equal(result.pending_evidence.final_publication.state, 'outstanding');
    assert.match(result.preparation_sha256, /^[a-f0-9]{64}$/);
  });
});

test('client accepts an intent produced by the merged signer Worker', async () => {
  await fixtureAsync(async ({ candidate }) => {
    const env = { UK_AQ_ENV_NAME: 'TEST', UK_AQ_JSONGEN_SIGNER_ENABLED: 'true',
      UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID: 'A'.repeat(20),
      UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY: 's'.repeat(40),
      UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN: signer.writerToken,
      UK_AQ_JSONGEN_PRUNE_CONNECTOR_IDS: '1',
      UK_AQ_JSONGEN_SIGNER_RATE_LIMIT: { limit: async () => ({ success: true }) } };
    let putCount = 0;
    const result = await uploadPrunePendingSource({ signer, ...candidate,
      fetchImpl: async (url, options) => {
        if (options.method === 'POST') return signerWorker.fetch(new Request(url, options), env);
        putCount++;
        assert.equal(options.method, 'PUT');
        assert.equal(options.headers['If-None-Match'], '*');
        return new Response(null, { status: 200 });
      } });
    assert.equal(putCount, 1);
    assert.equal(result.state, 'put_acknowledged_unverified');
  });
});

test('mismatched signer metadata blocks PUT; statuses remain unverified and do not retry', async () => {
  await fixtureAsync(async ({ candidate }) => {
    let calls = 0;
    await assert.rejects(uploadPrunePendingSource({ signer, ...candidate, connectorId: 2,
      fetchImpl: async () => { calls++; assert.fail('disallowed connector cannot request signing'); } }),
    { code: 'connector_not_allowed' });
    assert.equal(calls, 0);
    await assert.rejects(uploadPrunePendingSource({ signer, ...candidate,
      fetchImpl: async (_url, options) => { calls++; return Response.json(signedIntent(JSON.parse(options.body),
        { object: { bucket: 'wrong' } })); } }), { code: 'invalid_signer_response' });
    assert.equal(calls, 1);
    for (const [status, code] of [[412, 'upload_precondition_failed'], [409, 'upload_ambiguous'],
      [503, 'upload_ambiguous'], [403, 'upload_rejected']]) {
      calls = 0;
      await assert.rejects(uploadPrunePendingSource({ signer, ...candidate,
        fetchImpl: async (_url, options) => { calls++; return calls === 1
          ? Response.json(signedIntent(JSON.parse(options.body))) : new Response(null, { status }); } }),
      { code });
      assert.equal(calls, 2);
    }
  });
});

test('one deadline aborts the signer request and prevents PUT', async () => {
  await fixtureAsync(async ({ candidate }) => {
    let calls = 0;
    await assert.rejects(uploadPrunePendingSource({ signer, ...candidate, deadlineMs: 20,
      fetchImpl: async (_url, { signal }) => { calls++; return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); } }),
    { code: 'upload_deadline' });
    assert.equal(calls, 1);
  });
});

test('a validated intent that times out before PUT retains its intent-only reference', async () => {
  await fixtureAsync(async ({ candidate }) => {
    let calls = 0;
    await assert.rejects(uploadPrunePendingSource({ signer, ...candidate, deadlineMs: 20,
      fetchImpl: async (_url, options) => {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 30));
        return Response.json(signedIntent(JSON.parse(options.body)));
      } }), error => {
      assert.equal(error.code, 'intent_issued');
      assert.equal(error.intent_id, 'b'.repeat(64));
      assert.equal(error.reference.bucket, BUCKET);
      assert.equal(error.reference.upload_url, undefined);
      return true;
    });
    assert.equal(calls, 1);
  });
});

test('PUT deadline is ambiguous and retains only a safe reconciliation reference', async () => {
  await fixtureAsync(async ({ candidate }) => {
    let calls = 0;
    await assert.rejects(uploadPrunePendingSource({ signer, ...candidate, deadlineMs: 20,
      fetchImpl: async (_url, options) => {
        calls++;
        if (calls === 1) return Response.json(signedIntent(JSON.parse(options.body)));
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      } }), error => {
      assert.equal(error.code, 'upload_ambiguous');
      assert.match(error.reference.key, /pending\/unverified\/prune_daily_v3/);
      assert.equal(error.reference.upload_url, undefined);
      return true;
    });
    assert.equal(calls, 2);
  });
});

test('exact writer metadata bytes are retained by value only for a complete bounded reference set', () => {
  const { args, entries, snapshot } = sampleOriginalMetadataSnapshot();
  assert.equal(snapshot.completeness, 'exact_writer_metadata_captured_unverified');
  assert.equal(snapshot.required_object_count, 6);
  for (const entry of entries) {
    const stored = snapshot.objects.find(object => object.key === entry.reference.key);
    assert.equal(Buffer.from(stored.bytes_base64, 'base64').equals(entry.body), true);
    assert.equal(stored.sha256, entry.reference.sha256);
  }
  const missing = preparePruneOriginalMetadataSnapshot({
    ...args, exactReferences: [{ ...entries[2].reference, sha256: '0'.repeat(64) }],
  });
  assert.equal(missing.completeness, 'not_captured');
  assert.equal(missing.reason, 'original_bytes_unavailable');
  assert.equal(missing.objects, undefined);
  const missingDay = preparePruneOriginalMetadataSnapshot({
    ...args, affectedDaysUtc: [dayUtc, '2025-01-03'],
  });
  assert.equal(missingDay.completeness, 'not_captured');
  assert.deepEqual(missingDay.missing_roles, ['day_manifest']);
  const conflicting = preparePruneOriginalMetadataSnapshot({
    ...args, exactReferences: [{ ...entries[0].reference, sha256: '0'.repeat(64) }],
  });
  assert.equal(conflicting.reason, 'conflicting_publication_reference');
  assert.equal(conflicting.completeness, 'not_captured');
  const oversized = preparePruneOriginalMetadataSnapshot({
    ...args, latestReferences: [{ ...entries[5].reference, byte_size: 786433 }],
  });
  assert.equal(oversized.completeness, 'not_captured');
  assert.equal(oversized.reason, 'metadata_payload_exceeds_1mib');
});

test('pre-commit final preparation and outbox description retain only unverified original evidence', async () => {
  await fixtureAsync(async ({ candidate }) => {
    const prepared = preparePrunePendingSource(candidate);
    const source = signedIntent({ compressed_sha256: prepared.compressed_sha256,
      compressed_byte_size: prepared.compressed_byte_size,
      uncompressed_sha256: prepared.uncompressed_sha256,
      uncompressed_byte_size: prepared.uncompressed_byte_size }).object;
    const pending = { state: 'put_acknowledged_unverified', intent_id: 'b'.repeat(64),
      source, pending_evidence: { ...prepared.evidence, signed_upload: {
        intent_id: 'b'.repeat(64), object: source, disposition: 'put_acknowledged_unverified' } } };
    const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
    pending.source_evidence_sha256 = sha(prepared.evidence);
    pending.preparation_sha256 = sha(pending.pending_evidence);
    const metadata = sampleOriginalMetadataSnapshot();
    const manifestKey = metadata.entries[0].reference.key;
    const connector = { run_id: runId, day_utc: dayUtc, connector_id: 1,
      manifest_key: manifestKey, manifest_hash: 'e'.repeat(64),
      connector_manifest: { bucket: metadata.args.bucket,
        ...metadata.entries[0].reference },
      pollutant_manifests: prepared.evidence.scope.pollutant_partitions
        .map(partition => ({ ...partition, manifest: metadata.entries[1].reference })),
      scoped_roots: [] };
    const finalization = { ok: true, affected_days_utc: [dayUtc],
      canonical_aggregate_result: { canonical_aggregate_authority_verified: true,
        parent_state_reread_under_lock: true, affected_days_utc: [dayUtc] },
      v3_publication: { exact_scopes: [{ ok: true }], latest_global: { ok: true } } };
    const finalPreparation = preparePruneOriginalFinalEvidence({
      pending, connector, finalization,
      runId, dayUtc, connectorId: 1, writerGitSha: '4'.repeat(40),
      sourceIdentity: candidate.sourceIdentity,
      originalMetadataSnapshot: metadata.snapshot,
    });
    assert.equal(finalPreparation.envelope.original_candidate_connector_gate.transaction_state,
      'not_asserted_in_preparation');
    assert.equal(canonicalJson(finalPreparation.envelope).equals(finalPreparation.bytes), true);
    assert.equal(finalPreparation.bytes.includes(Buffer.from('commit_returned')), false);
    const evidence = describePruneGateOutboxEvidence({ pending, connector, finalPreparation });
    assert.equal(evidence.final_evidence_state, 'prepared_unverified');
    assert.equal(evidence.pending_disposition, 'put_acknowledged_unverified');
    assert.equal(evidence.original_source_status_provenance, 'original_source_status_unavailable');
    assert.equal(evidence.connector_manifest_byte_sha256, metadata.entries[0].reference.sha256);
    assert.equal(decodePruneMetadataEvidence(finalPreparation.envelope).original_metadata_snapshot.objects.length, 6);
    assert.deepEqual(finalPreparation.envelope.pending.source_evidence.scope,
      prepared.evidence.scope);
    const acceptance = { event_schema_version: 1, environment: 'TEST', writer_identity: 'prune_daily_v3',
      run_id: runId, attempt_id: runId, writer_git_sha: '4'.repeat(40), day_utc: dayUtc, connector_id: 1,
      ...candidate.sourceIdentity, history_manifest_key: manifestKey, history_manifest_hash: 'e'.repeat(64),
      gate_history_completed_at: '2026-10-10 12:34:56.789+00',
      gate_completion_source: 'prune_daily_phase_b', candidate_ready_marker: 'PRUNE_FIRST_DELETE_READY:v1',
      ...evidence, final_evidence_sha256: finalPreparation.sha256,
      final_evidence_byte_size: finalPreparation.byte_size };
    const reference = preparePrunePostCommitHandover(acceptance);
    assert.equal(reference.state, 'reference_prepared');
    assert.equal(reference.delivery_state, 'not_attempted');
    assert.equal(reference.ready_for_independent_authentication, true);
    assert.equal(reference.message.authority_state, 'requires_independent_authentication');
    assert.equal(reference.message.pending.object.key, source.key);
    assert.ok(reference.byte_size <= 4096);
    assert.deepEqual(preparePrunePostCommitHandover({ ...acceptance,
      source_content_hash_row_count: String(acceptance.source_content_hash_row_count),
      gate_history_completed_at: new Date(acceptance.gate_history_completed_at),
      final_evidence_byte_size: String(finalPreparation.byte_size) }), reference);
    assert.throws(() => preparePruneOriginalFinalEvidence({
      pending: { ...pending, preparation_sha256: '0'.repeat(64) }, connector,
      finalization,
      runId, dayUtc, connectorId: 1, writerGitSha: '4'.repeat(40), sourceIdentity: candidate.sourceIdentity,
      originalMetadataSnapshot: metadata.snapshot,
    }), /differs from original complete frozen source/);
    const overLimit = preparePruneOriginalFinalEvidence({
      pending, connector, finalization,
      runId, dayUtc, connectorId: 1, writerGitSha: '4'.repeat(40),
      sourceIdentity: candidate.sourceIdentity,
      originalMetadataSnapshot: { ...metadata.snapshot, objects:
        metadata.snapshot.objects.map((object, index) => index === 0
          ? { ...object, bytes_base64: 'a'.repeat(1024 * 1024) } : object) },
    });
    assert.equal(overLimit.envelope.original_metadata_snapshot.completeness, 'not_captured');
    assert.equal(overLimit.envelope.original_metadata_snapshot.reason, 'contradictory_original_metadata_encoding');
    assert.equal(describePruneGateOutboxEvidence({ pending, connector,
      finalPreparation: overLimit }).final_evidence_state, 'not_captured');
    assert.throws(() => preparePruneOriginalFinalEvidence({
      pending, connector, finalization,
      runId, dayUtc, connectorId: 1, writerGitSha: '4'.repeat(40),
      sourceIdentity: candidate.sourceIdentity,
      originalMetadataSnapshot: { ...metadata.snapshot, invocation_id: 'another-run' },
    }), /snapshot is not bound/);
    const incomplete = preparePruneOriginalFinalEvidence({
      pending, connector, finalization,
      runId, dayUtc, connectorId: 1, writerGitSha: '4'.repeat(40),
      sourceIdentity: candidate.sourceIdentity,
    });
    assert.equal(describePruneGateOutboxEvidence({ pending, connector,
      finalPreparation: incomplete }).final_evidence_state, 'not_captured');
    assert.equal(describePruneGateOutboxEvidence({ pending: { state: 'no_intent' }, connector })
      .final_evidence_state, 'not_captured');
    assert.equal(describePruneGateOutboxEvidence({ pending: { state: 'not_attempted' }, connector })
      .pending_intent_id, null);
  });
});

test('isolated private reader verifies bounded stored bytes and source identity', async () => {
  await fixtureAsync(async ({ candidate }) => {
    const prepared = preparePrunePendingSource(candidate);
    const reference = signedIntent({ compressed_sha256: prepared.compressed_sha256,
      compressed_byte_size: prepared.compressed_byte_size,
      uncompressed_sha256: prepared.uncompressed_sha256,
      uncompressed_byte_size: prepared.uncompressed_byte_size }).object;
    const intentId = createHash('sha256').update(JSON.stringify([
      'uk_aq_jsongen_upload_intent_v1', BUCKET, reference.key,
      'prune_daily_v3', runId, 'v3', 1, dayUtc,
      'connector_day_observations_ndjson_gzip', reference.byte_size, reference.sha256,
      reference.json_byte_size, reference.json_sha256, 'connector_day', 1, dayUtc,
    ])).digest('hex');
    let stored = prepared.body;
    const r2 = { bucket: BUCKET,
      endpoint: 'https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com',
      region: 'auto', adapter: { async getObjectBounded() { return { body: stored, bytes: stored.length }; } } };
    const verified = await verifyPrunePendingSource({ r2, reference, intentId, ...candidate });
    assert.equal(verified.state, 'source_bytes_verified');
    assert.deepEqual(verified.pending_evidence, prepared.evidence);
    await assert.rejects(verifyPrunePendingSource({ r2, reference, intentId,
      expectedEvidenceSha256: '0'.repeat(64), ...candidate }),
    { code: 'invalid_object_identity' });
    await assert.rejects(verifyPrunePendingSource({ r2, reference, intentId: 'a'.repeat(64), ...candidate }),
      { code: 'invalid_object_identity' });
    stored = Buffer.from('wrong');
    await assert.rejects(verifyPrunePendingSource({ r2, reference, intentId, ...candidate }),
      { code: 'invalid_object_identity' });
  });
});
