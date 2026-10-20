#!/usr/bin/env node
// Manual, isolated real-TEST signed transport acceptance. Intentionally no
// PostgreSQL, Prune invocation, canonical R2 access or JSONgen registration.
// One small immutable synthetic object remains in private derived TEST R2.
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const DAY = '2099-12-31'; // Clearly synthetic; no original writer gate/outbox.
const PREFIX = 'managed/jsongen/v1/evidence-bundles/prune_daily_v3';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const abort = code => { const e = new Error(code); e.check_code = code; throw e; };
const ensure = (condition, code) => { if (!condition) abort(code); };
const get = name => {
  const v = process.env[name];
  ensure(typeof v === 'string' && v.length > 0, 'missing_configuration');
  return v;
};
const env = get('UK_AQ_ENV_NAME');
const endpoint = get('UK_AQ_JSONGEN_PRUNE_SIGNER_URL');
const r2Endpoint = get('UK_AQ_JSONGEN_R2_ENDPOINT');
const bucket = get('UK_AQ_JSONGEN_R2_BUCKET');
const accessId = get('UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID');
const accessSecret = get('UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET');
const writerToken = get('UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN');
const gitSha = get('GITHUB_SHA');
ensure(env === 'TEST' && process.env.GITHUB_REPOSITORY === 'TEST-uk-aq/uk-aq-ops'
  && process.env.GITHUB_REF === 'refs/heads/main'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  && get('UK_AQ_JSONGEN_ISOLATED_R2_WRITE_CONFIRMED') === 'true',
'operation_not_authorised');
ensure(/^[a-f0-9]{40}$/.test(gitSha) && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket),
  'invalid_configuration');
const signer = new URL(endpoint);
const r2 = new URL(r2Endpoint);
ensure(signer.protocol === 'https:' && signer.pathname === '/v1/upload-intents'
  && !signer.search && !signer.hash && !signer.username && !signer.password
  && r2.protocol === 'https:' && r2.pathname === '/'
  && !r2.search && !r2.hash && !r2.username && !r2.password,
'invalid_endpoint_configuration');

const headers = {
  'CF-Access-Client-Id': accessId,
  'CF-Access-Client-Secret': accessSecret,
  Authorization: `Bearer ${writerToken}`,
  'Content-Type': 'application/json',
};
const manifestKey = `history/v3/observations/day_utc=${DAY}/connector_id=1/manifest.json`;

function specimen() {
  const id = randomUUID();
  const json = Buffer.from(JSON.stringify({
    kind: 'uk_aq_jsongen_isolated_transport_probe',
    synthetic_only: true, invocation_id: id,
  }) + '\n', 'utf8');
  const compressed = gzipSync(json, { mtime: 0, level: 6 });
  ensure(compressed.length > 0 && compressed.length < 2048, 'invalid_probe_body');
  const request = {
    writer_identity: 'prune_daily_v3',
    invocation_id: id,
    attempt_id: id,
    writer_git_sha: gitSha,
    environment: 'TEST',
    index_generation: 'v3',
    connector_id: 1,
    day_utc: DAY,
    object_type: 'prune_original_final_evidence_bundle_gzip',
    compressed_byte_size: compressed.length,
    compressed_sha256: sha256(compressed),
    uncompressed_byte_size: json.length,
    uncompressed_sha256: sha256(json),
    source_evidence_sha256: sha256(Buffer.from(`probe-source-evidence:${id}`)),
    source_identity_sha256: sha256(Buffer.from(`probe-source-identity:${id}`)),
    connector_manifest_key: manifestKey,
    connector_manifest_sha256: sha256(Buffer.from(`probe-manifest:${id}`)),
    original_final_batch_sha256: sha256(Buffer.from(`probe-final-batch:${id}`)),
    scope: { kind: 'connector_day', connector_id: 1, day_utc: DAY },
  };
  return { id, request, compressed };
}

function validateSignedUrl(raw, key, kind, expiry) {
  ensure(typeof raw === 'string' && raw.length < 8192, 'invalid_signed_url');
  const u = new URL(raw);
  const expectedPath = `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  ensure(u.protocol === 'https:' && u.host === r2.host && u.pathname === expectedPath
    && !u.username && !u.password && !u.hash && u.searchParams.size === 6,
  'signed_url_wrong_target');
  const q = u.searchParams;
  const date = q.get('X-Amz-Date') || '';
  const signedAt = /^\d{8}T\d{6}Z$/.test(date)
    ? Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${date.slice(9,11)}:${date.slice(11,13)}:${date.slice(13,15)}Z`)
    : NaN;
  const expectedHeaders = kind === 'PUT'
    ? 'content-type;host;if-none-match;x-amz-checksum-sha256' : 'host';
  ensure(Number.isFinite(signedAt)
    && q.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && q.get('X-Amz-Expires') === '60'
    && q.get('X-Amz-SignedHeaders') === expectedHeaders
    && new RegExp(`^[^/]+/${date.slice(0, 8)}/auto/s3/aws4_request$`).test(q.get('X-Amz-Credential') || '')
    && /^[a-f0-9]{64}$/.test(q.get('X-Amz-Signature') || '')
    && Date.parse(expiry) === signedAt + 60000
    && Date.parse(expiry) > Date.now() + 2000,
  'invalid_signature_metadata');
  return u.href; // Never log or persist this bearer URL.
}

async function issueIntent({request}) {
  const res = await fetch(endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers, body: JSON.stringify(request),
  });
  ensure(res.status === 200, 'signer_intent_not_issued');
  const json = await res.json();
  const key = `${PREFIX}/connector_id=1/day_utc=${DAY}/invocation=${request.invocation_id}/compressed_sha256=${request.compressed_sha256}.json.gz`;
  ensure(json?.state === 'signed_upload_intent'
    && /^[a-f0-9]{64}$/.test(json.intent_id || '')
    && json.object?.bucket === bucket && json.object?.key === key
    && json.object?.byte_size === request.compressed_byte_size
    && json.object?.sha256 === request.compressed_sha256
    && json.object?.json_byte_size === request.uncompressed_byte_size
    && json.object?.json_sha256 === request.uncompressed_sha256
    && JSON.stringify(json.bundle_identity) === JSON.stringify(request),
  'invalid_bundle_intent_identity');
  const required = json.required_headers;
  ensure(required && Object.keys(required).length === 3
    && required['Content-Type'] === 'application/gzip'
    && required['If-None-Match'] === '*'
    && required['x-amz-checksum-sha256'] === Buffer.from(request.compressed_sha256, 'hex').toString('base64'),
  'invalid_bundle_signed_headers');
  return {
    put: validateSignedUrl(json.upload_url, key, 'PUT', json.expires_at_utc),
    get: validateSignedUrl(json.readback_url, key, 'GET', json.readback_expires_at_utc),
    putHeaders: required, getExpiresMs: Date.parse(json.readback_expires_at_utc),
  };
}

async function boundedBody(response, maximum) {
  const reader = response.body?.getReader();
  ensure(reader, 'r2_response_missing_body');
  let count = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      ensure(count <= maximum, 'r2_response_oversize');
      chunks.push(Buffer.from(part.value));
    }
  } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function put(url, signedHeaders, bytes) {
  const res = await fetch(url, {
    method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: signedHeaders, body: bytes,
  });
  const status = res.status;
  try { await res.body?.cancel(); } catch {}
  return status;
}
async function getObject(url, expected) {
  const response = await fetch(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'Cache-Control': 'no-store' },
  });
  ensure(response.status === 200, 'r2_bundle_get_failed');
  const body = await boundedBody(response, 2048);
  ensure(body.length === expected.length && sha256(body) === sha256(expected)
    && body.equals(expected), 'r2_bundle_exact_readback_mismatch');
}

try {
  const valid = specimen();
  const validIntent = await issueIntent(valid);
  ensure([200, 201, 204].includes(await put(validIntent.put, validIntent.putHeaders, valid.compressed)),
    'r2_valid_conditional_put_failed');
  console.log('PASS: isolated signed bundle PUT accepted by R2');
  await getObject(validIntent.get, valid.compressed);
  console.log('PASS: exact private signed GET readback (byte length, SHA-256 and bytes)');

  ensure((await put(validIntent.put, validIntent.putHeaders, valid.compressed)) === 412,
    'r2_immutable_retry_not_412');
  await getObject(validIntent.get, valid.compressed);
  console.log('PASS: repeated conditional PUT rejected with 412; original bytes intact');

  const negative = specimen(); // Different UUID and key, so not masked by 412.
  const negativeIntent = await issueIntent(negative);
  const corrupted = Buffer.from(negative.compressed);
  corrupted[corrupted.length - 1] ^= 1;
  ensure((await put(negativeIntent.put, negativeIntent.putHeaders, corrupted)) === 400,
    'r2_incorrect_checksum_not_rejected_400');
  const absent = await fetch(negativeIntent.get, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  ensure(absent.status === 404, 'r2_rejected_checksum_object_present');
  try { await absent.body?.cancel(); } catch {}
  console.log('PASS: wrong body/checksum rejected with HTTP 400; no object created');

  const wait = validIntent.getExpiresMs + 15000 - Date.now();
  ensure(wait >= 0 && wait <= 80000, 'r2_expiry_check_timing_invalid');
  if (wait > 0) await delay(wait);
  const expired = await fetch(validIntent.get, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  ensure([400, 403].includes(expired.status), 'r2_expired_get_not_rejected');
  try { await expired.body?.cancel(); } catch {}
  console.log('PASS: expired 60-second signed GET rejected by R2');
  console.log('PASS: isolated TEST evidence-bundle transport; one small immutable synthetic object retained');
  console.log('No Prune, SQL, outbox, canonical history, consumer or publication operations');
} catch (err) {
  // Deliberately never print fetch errors, URLs, request/response bodies or secrets.
  console.error('FAIL:', err?.check_code || 'isolated_transport_request_failed');
  process.exitCode = 1;
}
