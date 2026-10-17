// Best-effort signed transport only. A PUT acknowledgment is not verified retention.
import { BUCKET } from './schema.mjs';
import { preparePrunePendingSource } from './prune-pending-source.mjs';
import { isIP } from 'node:net';

const HOST = '41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com';
const PREFIX = 'managed/jsongen/v1/pending/unverified/prune_daily_v3';
const SHA = /^[a-f0-9]{64}$/;
export const PRUNE_SIGNED_UPLOAD_DEADLINE_MS = 15_000;

export function resolvePruneSignerConfig(env) {
  if (env.UK_AQ_ENV_NAME !== 'TEST') throw new Error('TEST environment required for Prune signer handover');
  let url;
  try { url = new URL(String(env.UK_AQ_JSONGEN_PRUNE_SIGNER_URL || '').trim()); }
  catch { throw new Error('Prune signer URL required'); }
  if (url.protocol !== 'https:' || !url.hostname || url.port || url.username || url.password
    || url.pathname !== '/v1/upload-intents' || url.search || url.hash
    || url.hostname === 'localhost' || isIP(url.hostname) || url.hostname.endsWith('.workers.dev'))
    throw new Error('Prune signer URL must be a reviewed HTTPS Access route /v1/upload-intents');
  const writerToken = String(env.UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN || '');
  const accessId = String(env.UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID || '');
  const accessSecret = String(env.UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET || '');
  if (writerToken.length < 32 || !accessId || !accessSecret
    || [env.CFLARE_R2_SECRET_ACCESS_KEY, env.UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY].includes(writerToken)
    || [env.CFLARE_R2_SECRET_ACCESS_KEY, env.UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY].includes(accessSecret))
    throw new Error('Dedicated Prune signer token and Access credentials required');
  return { endpoint: url.href, writerToken, accessId, accessSecret };
}

function failure(code, message) { const error = new Error(message); error.code = code; return error; }

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('invalid_signer_response', 'Signer response has no body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8192) throw failure('invalid_signer_response', 'Signer metadata exceeds limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw failure('invalid_signer_response', 'Signer metadata is invalid JSON'); }
}

function validateIntent(intent, prepared, candidate) {
  const { runId, dayUtc, connectorId } = candidate;
  const key = `${PREFIX}/connector_id=${connectorId}/day_utc=${dayUtc}`
    + `/invocation=${encodeURIComponent(runId)}/compressed_sha256=${prepared.compressed_sha256}`
    + `/uncompressed_sha256=${prepared.uncompressed_sha256}.ndjson.gz`;
  const object = intent?.object;
  const headers = intent?.required_headers;
  const checksum = Buffer.from(prepared.compressed_sha256, 'hex').toString('base64');
  if (intent?.state !== 'signed_upload_intent' || !SHA.test(intent?.intent_id)
    || object?.bucket !== BUCKET || object?.key !== key
    || object?.sha256 !== prepared.compressed_sha256 || object?.byte_size !== prepared.compressed_byte_size
    || object?.json_sha256 !== prepared.uncompressed_sha256 || object?.json_byte_size !== prepared.uncompressed_byte_size
    || !headers || Object.keys(headers).length !== 3 || headers['Content-Type'] !== 'application/gzip'
    || headers['If-None-Match'] !== '*' || headers['x-amz-checksum-sha256'] !== checksum)
    throw failure('invalid_signer_response', 'Signer metadata differs from frozen source');
  let url;
  try { url = new URL(intent.upload_url); }
  catch { throw failure('invalid_signer_response', 'Signer upload URL invalid'); }
  const date = url.searchParams.get('X-Amz-Date') || '';
  const signedAt = /^\d{8}T\d{6}Z$/.test(date)
    ? Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`) : NaN;
  const expires = Date.parse(intent.expires_at_utc);
  const credential = url.searchParams.get('X-Amz-Credential') || '';
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password
    || decodeURIComponent(url.pathname) !== `/${BUCKET}/${key}` || url.hash
    || url.searchParams.size !== 6
    || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
    || !new RegExp(`^[^/]+/${date.slice(0, 8)}/auto/s3/aws4_request$`).test(credential)
    || url.searchParams.get('X-Amz-Expires') !== '60'
    || url.searchParams.get('X-Amz-SignedHeaders') !== 'content-type;host;if-none-match;x-amz-checksum-sha256'
    || !SHA.test(url.searchParams.get('X-Amz-Signature'))
    || !Number.isFinite(signedAt) || !Number.isFinite(expires) || expires !== signedAt + 60_000
    || expires < Date.now() + 2_000)
    throw failure('invalid_signer_response', 'Signer upload URL unbound or expired');
  return { intent_id: intent.intent_id, object, upload_url: url.href, required_headers: headers };
}

export async function uploadPrunePendingSource({ signer, fetchImpl = fetch,
  deadlineMs = PRUNE_SIGNED_UPLOAD_DEADLINE_MS, ...candidate }) {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const prepared = preparePrunePendingSource(candidate);
    if (Date.now() - started >= deadlineMs) throw failure('upload_deadline', 'Optional handover deadline exceeded');
    const request = { writer_identity: 'prune_daily_v3', invocation_id: candidate.runId,
      index_generation: 'v3', connector_id: candidate.connectorId, day_utc: candidate.dayUtc,
      object_type: 'connector_day_observations_ndjson_gzip',
      compressed_byte_size: prepared.compressed_byte_size, compressed_sha256: prepared.compressed_sha256,
      uncompressed_byte_size: prepared.uncompressed_byte_size, uncompressed_sha256: prepared.uncompressed_sha256,
      scope: { kind: 'connector_day', connector_id: candidate.connectorId, day_utc: candidate.dayUtc } };
    let response;
    try { response = await fetchImpl(signer.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${signer.writerToken}`, 'Content-Type': 'application/json',
        'CF-Access-Client-Id': signer.accessId, 'CF-Access-Client-Secret': signer.accessSecret },
      body: JSON.stringify(request) }); }
    catch { throw failure(controller.signal.aborted ? 'upload_deadline' : 'signer_transport_unavailable',
      'Signer request did not complete'); }
    if (!response.ok) {
      const code = [401, 403].includes(response.status) ? 'signer_auth_rejected'
        : response.status === 429 ? 'signer_rate_limited'
          : response.status >= 500 ? 'signer_unavailable' : 'signer_rejected';
      await response.body?.cancel().catch(() => {});
      throw failure(code, `Signer returned HTTP ${response.status}`);
    }
    const intent = validateIntent(await boundedJson(response), prepared, candidate);
    const putFailure = (code, message) => Object.assign(failure(code, message),
      { reference: intent.object, intent_id: intent.intent_id });
    if (controller.signal.aborted || Date.now() - started >= deadlineMs)
      throw failure('upload_deadline', 'Optional handover deadline exceeded');
    let put;
    try { put = await fetchImpl(intent.upload_url, { method: 'PUT', redirect: 'error', signal: controller.signal,
      headers: intent.required_headers, body: prepared.body }); }
    catch (cause) { throw putFailure('upload_ambiguous',
      `Signed PUT outcome unknown: ${cause?.name || 'transport_error'}`); }
    if (controller.signal.aborted || Date.now() - started >= deadlineMs)
      throw putFailure('upload_ambiguous', 'Signed PUT returned after optional deadline; outcome needs reconciliation');
    if (put.status >= 200 && put.status < 300) return { state: 'put_acknowledged_unverified',
      intent_id: intent.intent_id, source: intent.object };
    if (put.status === 412) throw putFailure('upload_precondition_failed', 'Signed PUT precondition failed; independent readback required');
    if (put.status === 409 || put.status >= 500) throw putFailure('upload_ambiguous', `Signed PUT outcome unknown: HTTP ${put.status}`);
    throw putFailure('upload_rejected', `Signed PUT rejected: HTTP ${put.status}`);
  } catch (error) {
    if (controller.signal.aborted && error.code !== 'upload_ambiguous')
      throw Object.assign(failure('upload_deadline', 'Optional handover deadline exceeded'),
        { reference: error.reference, intent_id: error.intent_id });
    throw error;
  } finally { clearTimeout(timer); }
}
