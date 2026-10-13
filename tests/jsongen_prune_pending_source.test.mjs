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
    assert.equal((await verifyPrunePendingSource({ r2, reference, intentId, ...candidate })).state, 'source_bytes_verified');
    await assert.rejects(verifyPrunePendingSource({ r2, reference, intentId: 'a'.repeat(64), ...candidate }),
      { code: 'invalid_object_identity' });
    stored = Buffer.from('wrong');
    await assert.rejects(verifyPrunePendingSource({ r2, reference, intentId, ...candidate }),
      { code: 'invalid_object_identity' });
  });
});
