import { presignGet, presignPut } from './sigv4.mjs';

const PENDING_PREFIX = 'managed/jsongen/v1/pending/unverified';
const BUNDLE_PREFIX = 'managed/jsongen/v1/evidence-bundles';
const MAX_REQUEST_BYTES = 4096;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_JSON_BYTES = 64 * 1024 * 1024;
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
function validatePending(input) {
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

function validateEvidenceBundle(input, environment) {
  const fields = ['writer_identity', 'invocation_id', 'attempt_id', 'writer_git_sha',
    'environment', 'index_generation', 'connector_id', 'day_utc', 'object_type',
    'compressed_byte_size', 'compressed_sha256', 'uncompressed_byte_size',
    'uncompressed_sha256', 'source_evidence_sha256', 'source_identity_sha256',
    'connector_manifest_key', 'connector_manifest_sha256',
    'original_final_batch_sha256', 'scope'];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  return sameFields(input, fields) && input.writer_identity === WRITER
    && uuid.test(input.invocation_id) && input.attempt_id === input.invocation_id
    && input.environment === environment
    && /^[a-f0-9]{40}$/.test(input.writer_git_sha || '')
    && input.index_generation === 'v3' && isPositive(input.connector_id) && validDay(input.day_utc)
    && input.object_type === 'prune_original_final_evidence_bundle_gzip'
    && isPositive(input.compressed_byte_size) && input.compressed_byte_size <= MAX_BUNDLE_COMPRESSED_BYTES
    && isPositive(input.uncompressed_byte_size) && input.uncompressed_byte_size <= MAX_BUNDLE_JSON_BYTES
    && [input.compressed_sha256, input.uncompressed_sha256, input.source_evidence_sha256,
      input.source_identity_sha256, input.connector_manifest_sha256,
      input.original_final_batch_sha256].every(value => typeof value === 'string' && SHA.test(value))
    && input.connector_manifest_key === `history/v3/observations/day_utc=${input.day_utc}`
      + `/connector_id=${input.connector_id}/manifest.json`
    && sameFields(input.scope, ['kind', 'connector_id', 'day_utc'])
    && input.scope.kind === 'connector_day' && input.scope.connector_id === input.connector_id
    && input.scope.day_utc === input.day_utc;
}

function bundleIntentIdentity(bucket, key, input) {
  return [
    'uk_aq_jsongen_evidence_bundle_intent_v1', bucket, key,
    input.writer_identity, input.environment, input.invocation_id, input.attempt_id, input.writer_git_sha,
    input.index_generation, input.connector_id, input.day_utc, input.object_type,
    input.compressed_byte_size, input.compressed_sha256,
    input.uncompressed_byte_size, input.uncompressed_sha256,
    input.source_evidence_sha256, input.source_identity_sha256,
    input.connector_manifest_key, input.connector_manifest_sha256,
    input.original_final_batch_sha256,
    input.scope.kind, input.scope.connector_id, input.scope.day_utc,
  ];
}

export default {
  async fetch(request, env) {
    if (env.UK_AQ_JSONGEN_SIGNER_ENABLED !== 'true'
      || !['TEST', 'LIVE'].includes(env.UK_AQ_ENV_NAME))
      return error(503, 'disabled');
    const endpoint = new URL(request.url);
    if (endpoint.pathname !== '/v1/upload-intents' || request.method !== 'POST'
      || endpoint.search || request.headers.get('content-type') !== 'application/json')
      return error(404, 'invalid_endpoint');
    const accessKeyId = env.UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID;
    const secretAccessKey = env.UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY;
    const writerToken = env.UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN;
    const admitted = env.UK_AQ_JSONGEN_PRUNE_CONNECTOR_IDS;
    const accountId = env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID;
    const bucket = env.UK_AQ_JSONGEN_R2_BUCKET;
    if (typeof accessKeyId !== 'string' || accessKeyId.length < 16
      || typeof secretAccessKey !== 'string' || secretAccessKey.length < 32
      || typeof writerToken !== 'string' || writerToken.length < 32
      || typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)
      || typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
      || bucket.includes('..')
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
    const isBundle = input.object_type === 'prune_original_final_evidence_bundle_gzip';
    if (!(isBundle ? validateEvidenceBundle(input, env.UK_AQ_ENV_NAME) : validatePending(input)))
      return error(400, 'invalid_scope_or_object_identity');
    if (!admitted.split(',').some(value => Number(value) === input.connector_id))
      return error(403, 'unauthorised_scope');
    const prefix = isBundle ? `${BUNDLE_PREFIX}/${WRITER}` : `${PENDING_PREFIX}/${WRITER}`;
    const key = isBundle
      ? `${prefix}/connector_id=${input.connector_id}/day_utc=${input.day_utc}`
        + `/invocation=${encodeURIComponent(input.invocation_id)}`
        + `/compressed_sha256=${input.compressed_sha256}.json.gz`
      : `${prefix}/connector_id=${input.connector_id}/day_utc=${input.day_utc}`
        + `/invocation=${encodeURIComponent(input.invocation_id)}`
        + `/compressed_sha256=${input.compressed_sha256}/uncompressed_sha256=${input.uncompressed_sha256}.ndjson.gz`;
    try {
      const issuedAt = new Date();
      const signed = await presignPut({ accountId, accessKeyId, secretAccessKey,
        bucket, key, checksumBase64: checksumBase64(input.compressed_sha256),
        contentType: 'application/gzip', now: issuedAt });
      const readback = isBundle ? await presignGet({ accountId, accessKeyId,
        secretAccessKey, bucket, key, now: issuedAt }) : null;
      const intentIdentity = isBundle ? bundleIntentIdentity(bucket, key, input) : [
        'uk_aq_jsongen_upload_intent_v1', bucket, key,
        input.writer_identity, input.invocation_id, input.index_generation,
        input.connector_id, input.day_utc, input.object_type,
        input.compressed_byte_size, input.compressed_sha256,
        input.uncompressed_byte_size, input.uncompressed_sha256,
        input.scope.kind, input.scope.connector_id, input.scope.day_utc,
      ];
      // JSON array positions and JSON string escaping make complete validated
      // request identity deterministic and unambiguous. An intent is never
      // proof that R2 retained the body.
      const intentId = hex(await crypto.subtle.digest('SHA-256',
        encoder.encode(JSON.stringify(intentIdentity))));
      const object = { bucket, key,
        sha256: input.compressed_sha256, byte_size: input.compressed_byte_size,
        json_sha256: input.uncompressed_sha256, json_byte_size: input.uncompressed_byte_size };
      return Response.json({ intent_id: intentId, object,
        ...(isBundle ? { bundle_identity: Object.fromEntries(Object.keys(input).map(name => [name, input[name]])),
          readback_url: readback.url, readback_expires_at_utc: readback.expiresAtUtc } : {}),
        upload_url: signed.url, expires_at_utc: signed.expiresAtUtc,
        required_headers: signed.headers, state: 'signed_upload_intent' },
      { headers: { 'Cache-Control': 'no-store' } });
    } catch { return error(503, 'signing_failure'); }
  },
};
