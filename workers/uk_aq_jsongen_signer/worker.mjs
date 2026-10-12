import { presignPut } from './sigv4.mjs';

const BUCKET = 'uk-aq-chart-history-json-test';
const PREFIX = 'managed/jsongen/v1/pending/unverified';
const ACCOUNT_ID = '41a81f781d3bd7234fde0b25df51e879';
const MAX_REQUEST_BYTES = 4096;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const WRITER = 'prune_daily_v3';
const SHA = /^[a-f0-9]{64}$/;
const INVOCATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const encoder = new TextEncoder();
const error = (status, code) => Response.json({ error: code }, { status,
  headers: { 'Cache-Control': 'no-store' } });
const validDay = day => typeof day === 'string' && /^\d{4}-\d\d-\d\d$/.test(day)
  && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
  && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
const isPositive = n => Number.isSafeInteger(n) && n > 0;
const sameFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
function checksumBase64(digest) {
  const bytes = digest.match(/../g).map(part => parseInt(part, 16));
  return btoa(String.fromCharCode(...bytes));
}
async function authenticated(bearer, expected) {
  // Hash both tokens to avoid a variable-length early return on secrets.
  const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [left, right] = await Promise.all([digest(bearer), digest(expected)]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && bearer.length >= 32;
}
async function readSmallJson(request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  let count = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_REQUEST_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return undefined; } finally { reader.releaseLock(); }
}
function validate(input) {
  const fields = ['writer_identity', 'invocation_id', 'index_generation', 'connector_id',
    'day_utc', 'object_type', 'compressed_byte_size', 'compressed_sha256',
    'uncompressed_byte_size', 'uncompressed_sha256', 'scope'];
  if (!sameFields(input, fields) || input.writer_identity !== WRITER || !INVOCATION.test(input.invocation_id)
    || input.index_generation !== 'v3' || !isPositive(input.connector_id) || !validDay(input.day_utc)
    || input.object_type !== 'connector_day_observations_ndjson_gzip'
    || !isPositive(input.compressed_byte_size) || input.compressed_byte_size > MAX_COMPRESSED_BYTES
    || !isPositive(input.uncompressed_byte_size) || input.uncompressed_byte_size > MAX_UNCOMPRESSED_BYTES
    || typeof input.compressed_sha256 !== 'string' || !SHA.test(input.compressed_sha256)
    || typeof input.uncompressed_sha256 !== 'string' || !SHA.test(input.uncompressed_sha256)
    || !sameFields(input.scope, ['kind', 'connector_id', 'day_utc'])
    || input.scope.kind !== 'connector_day' || input.scope.connector_id !== input.connector_id
    || input.scope.day_utc !== input.day_utc) return false;
  return true;
}

export default {
  async fetch(request, env) {
    if (env.UK_AQ_JSONGEN_SIGNER_ENABLED !== 'true' || env.UK_AQ_ENV_NAME !== 'TEST')
      return error(503, 'disabled');
    const endpoint = new URL(request.url);
    if (endpoint.pathname !== '/v1/upload-intents' || request.method !== 'POST'
      || endpoint.search || request.headers.get('content-type') !== 'application/json')
      return error(404, 'invalid_endpoint');
    const accessKeyId = env.UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID;
    const secretAccessKey = env.UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY;
    const writerToken = env.UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN;
    const admitted = env.UK_AQ_JSONGEN_PRUNE_CONNECTOR_IDS;
    if (typeof accessKeyId !== 'string' || accessKeyId.length < 16
      || typeof secretAccessKey !== 'string' || secretAccessKey.length < 32
      || typeof writerToken !== 'string' || writerToken.length < 32
      || typeof admitted !== 'string' || admitted.length > 256
      || !/^\d+(,\d+)*$/.test(admitted)
      || !env.UK_AQ_JSONGEN_SIGNER_RATE_LIMIT?.limit
      || accessKeyId === env.CFLARE_R2_ACCESS_KEY_ID || writerToken === secretAccessKey)
      return error(503, 'invalid_signing_configuration');
    const bearer = request.headers.get('authorization');
    if (!bearer?.startsWith('Bearer ') || bearer.length > 512
      || !(await authenticated(bearer.slice(7), writerToken))) return error(401, 'authentication_failed');
    let allowed;
    try { allowed = await env.UK_AQ_JSONGEN_SIGNER_RATE_LIMIT.limit({ key: WRITER }); }
    catch { return error(503, 'rate_limit_unavailable'); }
    if (!allowed?.success) return error(429, 'rate_limited');
    const input = await readSmallJson(request);
    if (input === null) return error(413, 'request_too_large');
    if (!input || typeof input !== 'object') return error(400, 'invalid_request');
    if (input.writer_identity !== WRITER) return error(403, 'unauthorised_writer');
    if (input.index_generation !== 'v3') return error(400, 'invalid_generation');
    if (!validate(input)) return error(400, 'invalid_scope_or_object_identity');
    if (!admitted.split(',').some(value => Number(value) === input.connector_id))
      return error(403, 'unauthorised_scope');
    const key = `${PREFIX}/${WRITER}/connector_id=${input.connector_id}/day_utc=${input.day_utc}`
      + `/invocation=${encodeURIComponent(input.invocation_id)}`
      + `/compressed_sha256=${input.compressed_sha256}/uncompressed_sha256=${input.uncompressed_sha256}.ndjson.gz`;
    try {
      const issuedAt = new Date();
      const signed = await presignPut({ accountId: ACCOUNT_ID, accessKeyId, secretAccessKey,
        bucket: BUCKET, key, checksumBase64: checksumBase64(input.compressed_sha256),
        contentType: 'application/gzip', now: issuedAt });
      // JSON array positions and JSON string escaping make this complete,
      // validated identity deterministic and unambiguous. The key remains the
      // existing digest-scoped pending key; an intent is never proof of bytes.
      const intentIdentity = [
        'uk_aq_jsongen_upload_intent_v1', BUCKET, key,
        input.writer_identity, input.invocation_id, input.index_generation,
        input.connector_id, input.day_utc, input.object_type,
        input.compressed_byte_size, input.compressed_sha256,
        input.uncompressed_byte_size, input.uncompressed_sha256,
        input.scope.kind, input.scope.connector_id, input.scope.day_utc,
      ];
      const intentId = hex(await crypto.subtle.digest('SHA-256',
        encoder.encode(JSON.stringify(intentIdentity))));
      return Response.json({ intent_id: intentId, object: { bucket: BUCKET, key,
        sha256: input.compressed_sha256, byte_size: input.compressed_byte_size,
        json_sha256: input.uncompressed_sha256, json_byte_size: input.uncompressed_byte_size },
        upload_url: signed.url, expires_at_utc: new Date(issuedAt.getTime() + 60_000).toISOString(),
        required_headers: signed.headers, state: 'signed_upload_intent' },
      { headers: { 'Cache-Control': 'no-store' } });
    } catch { return error(503, 'signing_failure'); }
  },
};
