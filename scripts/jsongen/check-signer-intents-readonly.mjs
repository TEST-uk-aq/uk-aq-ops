#!/usr/bin/env node
// Post-deployment, sign-only TEST acceptance. No R2 PUT/GET, Prune or retention.
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const fail = code => { throw new Error(code); };
const assert = (value, code) => { if (!value) fail(code); };
const required = key => {
  const value = process.env[key];
  assert(typeof value === 'string' && value.length > 0, 'missing_configuration');
  return value;
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const url = required('UK_AQ_JSONGEN_PRUNE_SIGNER_URL');
const endpoint = required('UK_AQ_JSONGEN_R2_ENDPOINT');
const bucket = required('UK_AQ_JSONGEN_R2_BUCKET');
const accessId = required('UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID');
const accessSecret = required('UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET');
const writerToken = required('UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN');
assert(required('UK_AQ_ENV_NAME') === 'TEST', 'wrong_environment');
assert(process.env.GITHUB_REPOSITORY === 'TEST-uk-aq/uk-aq-ops'
  && process.env.GITHUB_REF === 'refs/heads/main'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'wrong_action_context');
const signer = new URL(url);
const r2 = new URL(endpoint);
assert(signer.protocol === 'https:' && signer.pathname === '/v1/upload-intents'
  && signer.search === '' && signer.hash === ''
  && r2.protocol === 'https:' && r2.pathname === '/'
  && r2.search === '' && r2.hash === '', 'invalid_endpoint_configuration');
assert(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket), 'invalid_bucket_configuration');

const day = '2099-12-31'; // Intent-only synthetic identity, never a Prune date.
const invocation = randomUUID();
const scope = { kind: 'connector_day', connector_id: 1, day_utc: day };
const original = Buffer.from('UK AQ TEST signer intent only: no R2 PUT or GET\n');
const zipped = gzipSync(original, { level: 6, mtime: 0 });
const common = {
  writer_identity: 'prune_daily_v3',
  invocation_id: invocation,
  index_generation: 'v3',
  connector_id: 1,
  day_utc: day,
  compressed_byte_size: zipped.length,
  compressed_sha256: sha(zipped),
  uncompressed_byte_size: original.length,
  uncompressed_sha256: sha(original),
  scope,
};
const pending = { ...common, object_type: 'connector_day_observations_ndjson_gzip' };
const evidence = {
  writer_identity: 'prune_daily_v3',
  invocation_id: invocation,
  attempt_id: invocation,
  writer_git_sha: required('GITHUB_SHA'),
  environment: 'TEST',
  index_generation: 'v3',
  connector_id: 1,
  day_utc: day,
  object_type: 'prune_original_final_evidence_bundle_gzip',
  compressed_byte_size: common.compressed_byte_size,
  compressed_sha256: common.compressed_sha256,
  uncompressed_byte_size: common.uncompressed_byte_size,
  uncompressed_sha256: common.uncompressed_sha256,
  source_evidence_sha256: sha(Buffer.from('synthetic source evidence')),
  source_identity_sha256: sha(Buffer.from('synthetic source identity')),
  connector_manifest_key: `history/v3/observations/day_utc=${day}/connector_id=1/manifest.json`,
  connector_manifest_sha256: sha(Buffer.from('synthetic manifest identity')),
  original_final_batch_sha256: sha(Buffer.from('synthetic batch identity')),
  scope,
};

const exactPath = (key) => `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
function checkSignedUrl(value, key, signedHeaders, expiry) {
  assert(typeof value === 'string', 'missing_signed_url');
  const target = new URL(value);
  assert(target.protocol === 'https:' && target.host === r2.host
    && target.pathname === exactPath(key) && !target.hash
    && !target.username && !target.password, 'signed_url_scope_mismatch');
  const q = target.searchParams;
  assert(q.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && q.get('X-Amz-SignedHeaders') === signedHeaders
    && q.get('X-Amz-Expires') === '60'
    && /^[a-f0-9]{64}$/.test(q.get('X-Amz-Signature') || '')
    && /^\d{8}T\d{6}Z$/.test(q.get('X-Amz-Date') || ''),
  'signed_url_parameters_invalid');
  const remaining = Date.parse(expiry) - Date.now();
  assert(Number.isFinite(remaining) && remaining > 0 && remaining <= 61000,
    'signed_url_expiry_invalid');
  // Never log, copy, persist or invoke this bearer URL.
}
const access = {
  'CF-Access-Client-Id': accessId,
  'CF-Access-Client-Secret': accessSecret,
};
async function request(body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) return { status: response.status, data: null };
  return { status: response.status, data: await response.json() };
}
function checkIntent(response, input, kind) {
  assert(response.status === 200 && response.data && typeof response.data === 'object',
    kind + '_intent_http_failure');
  const d = response.data;
  const key = kind === 'pending'
    ? `managed/jsongen/v1/pending/unverified/prune_daily_v3/connector_id=1/day_utc=${day}/invocation=${invocation}/compressed_sha256=${input.compressed_sha256}/uncompressed_sha256=${input.uncompressed_sha256}.ndjson.gz`
    : `managed/jsongen/v1/evidence-bundles/prune_daily_v3/connector_id=1/day_utc=${day}/invocation=${invocation}/compressed_sha256=${input.compressed_sha256}.json.gz`;
  assert(d.state === 'signed_upload_intent' && /^[a-f0-9]{64}$/.test(d.intent_id || '')
    && d.object?.bucket === bucket && d.object?.key === key
    && d.object.sha256 === input.compressed_sha256
    && d.object.byte_size === input.compressed_byte_size
    && d.object.json_sha256 === input.uncompressed_sha256
    && d.object.json_byte_size === input.uncompressed_byte_size,
  kind + '_intent_identity_invalid');
  const headers = d.required_headers || {};
  assert(Object.keys(headers).length === 3
    && headers['Content-Type'] === 'application/gzip'
    && headers['If-None-Match'] === '*'
    && headers['x-amz-checksum-sha256'] === Buffer.from(input.compressed_sha256, 'hex').toString('base64'),
  kind + '_signed_headers_invalid');
  checkSignedUrl(d.upload_url, key, 'content-type;host;if-none-match;x-amz-checksum-sha256', d.expires_at_utc);
  if (kind === 'pending') {
    assert(!Object.hasOwn(d, 'readback_url') && !Object.hasOwn(d, 'bundle_identity'),
      'pending_must_not_grant_get');
  } else {
    assert(JSON.stringify(d.bundle_identity) === JSON.stringify(input),
      'bundle_identity_mismatch');
    checkSignedUrl(d.readback_url, key, 'host', d.readback_expires_at_utc);
  }
}

try {
  // Access rejection is tested using a plain GET, which creates no intent.
  const unauthenticated = await fetch(url, { method: 'GET', redirect: 'manual',
    signal: AbortSignal.timeout(15000) });
  assert([401, 403].includes(unauthenticated.status), 'access_bypass_or_unexpected_response');
  console.log('PASS: Cloudflare Access rejects an unauthenticated request');

  const badBearer = await request(pending, access);
  assert(badBearer.status === 401, 'writer_bearer_not_enforced');
  console.log('PASS: Worker rejects missing writer bearer');

  const authenticated = { ...access, Authorization: `Bearer ${writerToken}` };
  checkIntent(await request(pending, authenticated), pending, 'pending');
  console.log('PASS: PENDING exact-key, conditional/checksum-bound signed PUT intent');

  checkIntent(await request(evidence, authenticated), evidence, 'bundle');
  console.log('PASS: evidence-bundle exact-key signed PUT and signed GET intents');

  console.log('PASS: sign-only TEST acceptance; zero R2 PUT/GET and zero Prune operations');
} catch (e) {
  // Do not print exception text, request details, signed URLs or credentials.
  const known = /^[a-z][a-z0-9_]*$/.test(e?.message || '');
  console.error('FAIL: signer intent check:', known ? e.message : 'request_or_response_failure');
  process.exitCode = 1;
}
