// Best-effort signed transport only. A PUT acknowledgment is not verified retention.
import { BUCKET, canonicalJson } from './schema.mjs';
import { preparePrunePendingSource } from './prune-pending-source.mjs';
import { isIP } from 'node:net';
import { sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { managedR2TargetConfig } from './r2-config.mjs';
import { PRUNE_EVIDENCE_BUNDLE_LIMITS, pruneEvidenceBundleIntentId } from './prune-evidence-bundle.mjs';

const PREFIX = 'managed/jsongen/v1/pending/unverified/prune_daily_v3';
const SHA = /^[a-f0-9]{64}$/;
export const PRUNE_SIGNED_UPLOAD_DEADLINE_MS = 15_000;
export const PRUNE_EVIDENCE_BUNDLE_UPLOAD_DEADLINE_MS = 5_000;
// Preserve the reviewed connector admission and existing signer protocol.
// Environment/repository admission comes from the shared explicit configuration.
export const PRUNE_PENDING_SOURCE_CONNECTOR_IDS = Object.freeze([1]);
export const isPrunePendingSourceConnector = connectorId =>
  PRUNE_PENDING_SOURCE_CONNECTOR_IDS.includes(connectorId);

export function resolvePruneSignerConfig(env) {
  const derivedTarget = managedR2TargetConfig(env);
  if (derivedTarget.bucket !== BUCKET) throw new Error('UK_AQ_JSONGEN_R2_BUCKET must be set before process launch');
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
  const suppliedR2Secrets = [env.CFLARE_R2_SECRET_ACCESS_KEY, env.UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY]
    .filter(value => typeof value === 'string' && value.length > 0);
  if (writerToken.length < 32 || !accessId || !accessSecret
    || suppliedR2Secrets.includes(writerToken) || suppliedR2Secrets.includes(accessSecret))
    throw new Error('Dedicated Prune signer token and Access credentials required');
  return { endpoint: url.href, writerToken, accessId, accessSecret, derivedTarget };
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

function validateIntent(intent, prepared, candidate, derivedTarget) {
  const { runId, dayUtc, connectorId } = candidate;
  const key = `${PREFIX}/connector_id=${connectorId}/day_utc=${dayUtc}`
    + `/invocation=${encodeURIComponent(runId)}/compressed_sha256=${prepared.compressed_sha256}`
    + `/uncompressed_sha256=${prepared.uncompressed_sha256}.ndjson.gz`;
  const object = intent?.object;
  const headers = intent?.required_headers;
  const checksum = Buffer.from(prepared.compressed_sha256, 'hex').toString('base64');
  if (intent?.state !== 'signed_upload_intent' || !SHA.test(intent?.intent_id)
    || object?.bucket !== derivedTarget.bucket || object?.key !== key
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
  if (url.protocol !== 'https:' || url.hostname !== new URL(derivedTarget.endpoint).hostname
    || url.port || url.username || url.password
    || decodeURIComponent(url.pathname) !== `/${derivedTarget.bucket}/${key}` || url.hash
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
  deadlineMs = PRUNE_SIGNED_UPLOAD_DEADLINE_MS, deadlineAtMs = null,
  prepared: preparedInput = null, ...candidate }) {
  const controller = new AbortController();
  const started = Date.now();
  const endAt = Number.isSafeInteger(deadlineAtMs) ? deadlineAtMs : started + deadlineMs;
  const timer = setTimeout(() => controller.abort(), Math.max(1, endAt - started));
  let evidenceSha256 = null;
  const transport = { handover_attempted: true, signer_intent_state: 'not_attempted',
    put_state: 'not_attempted', duration_ms: null };
  try {
    if (!isPrunePendingSourceConnector(candidate.connectorId))
      throw failure('connector_not_allowed', 'Connector not admitted for optional Prune handover');
    const prepared = preparedInput || preparePrunePendingSource(candidate);
    evidenceSha256 = sha256Hex(canonicalJson(prepared.evidence));
    if (Date.now() >= endAt) throw failure('upload_deadline', 'Optional handover deadline exceeded');
    const request = { writer_identity: 'prune_daily_v3', invocation_id: candidate.runId,
      index_generation: 'v3', connector_id: candidate.connectorId, day_utc: candidate.dayUtc,
      object_type: 'connector_day_observations_ndjson_gzip',
      compressed_byte_size: prepared.compressed_byte_size, compressed_sha256: prepared.compressed_sha256,
      uncompressed_byte_size: prepared.uncompressed_byte_size, uncompressed_sha256: prepared.uncompressed_sha256,
      scope: { kind: 'connector_day', connector_id: candidate.connectorId, day_utc: candidate.dayUtc } };
    let response;
    transport.signer_intent_state = 'ambiguous';
    try { response = await fetchImpl(signer.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${signer.writerToken}`, 'Content-Type': 'application/json',
        'CF-Access-Client-Id': signer.accessId, 'CF-Access-Client-Secret': signer.accessSecret },
      body: JSON.stringify(request) }); }
    catch { throw failure(controller.signal.aborted ? 'upload_deadline' : 'signer_transport_unavailable',
      'Signer request did not complete'); }
    if (!response.ok) {
      transport.signer_intent_state = 'rejected';
      const code = [401, 403].includes(response.status) ? 'signer_auth_rejected'
        : response.status === 429 ? 'signer_rate_limited'
          : response.status >= 500 ? 'signer_unavailable' : 'signer_rejected';
      await response.body?.cancel().catch(() => {});
      throw failure(code, `Signer returned HTTP ${response.status}`);
    }
    const intent = validateIntent(await boundedJson(response), prepared, candidate, signer.derivedTarget);
    transport.signer_intent_state = 'accepted';
    const putFailure = (code, message) => Object.assign(failure(code, message),
      { reference: intent.object, intent_id: intent.intent_id });
    if (controller.signal.aborted || Date.now() >= endAt)
      throw putFailure('intent_issued', 'Optional handover deadline exceeded before PUT');
    let put;
    transport.put_state = 'ambiguous';
    try { put = await fetchImpl(intent.upload_url, { method: 'PUT', redirect: 'error', signal: controller.signal,
      headers: intent.required_headers, body: prepared.body }); }
    catch (cause) { throw putFailure('upload_ambiguous',
      `Signed PUT outcome unknown: ${cause?.name || 'transport_error'}`); }
    if (controller.signal.aborted || Date.now() >= endAt)
      throw putFailure('upload_ambiguous', 'Signed PUT returned after optional deadline; outcome needs reconciliation');
    if (put.status >= 200 && put.status < 300) {
      transport.put_state = 'acknowledged';
      transport.duration_ms = Math.max(0, Date.now() - started);
      const pendingEvidence = { ...prepared.evidence, signed_upload: {
        intent_id: intent.intent_id, object: intent.object,
        disposition: 'put_acknowledged_unverified',
      } };
      return { state: 'put_acknowledged_unverified',
        intent_id: intent.intent_id, source: intent.object,
        pending_evidence: pendingEvidence, source_evidence_sha256: evidenceSha256,
        preparation_sha256: sha256Hex(canonicalJson(pendingEvidence)), transport };
    }
    if (put.status === 412) throw putFailure('upload_precondition_failed', 'Signed PUT precondition failed; independent readback required');
    if (put.status === 409 || put.status >= 500) throw putFailure('upload_ambiguous', `Signed PUT outcome unknown: HTTP ${put.status}`);
    transport.put_state = 'rejected';
    throw putFailure('upload_rejected', `Signed PUT rejected: HTTP ${put.status}`);
  } catch (error) {
    transport.duration_ms = Math.max(0, Date.now() - started);
    if (error.code === 'invalid_signer_response') transport.signer_intent_state = 'invalid_response';
    if (controller.signal.aborted && error.code !== 'upload_ambiguous' && error.code !== 'intent_issued')
      throw Object.assign(failure('upload_deadline', 'Optional handover deadline exceeded'),
        { reference: error.reference, intent_id: error.intent_id,
          preparation_sha256: evidenceSha256, transport });
    if (evidenceSha256) error.preparation_sha256 = evidenceSha256;
    error.transport = transport;
    throw error;
  } finally { clearTimeout(timer); }
}

function validateBundleIntent(intent, prepared, identity, derivedTarget) {
  const bucket = derivedTarget.bucket;
  const key = `managed/jsongen/v1/evidence-bundles/prune_daily_v3/connector_id=${identity.connector_id}`
    + `/day_utc=${identity.day_utc}/invocation=${encodeURIComponent(identity.invocation_id)}`
    + `/compressed_sha256=${prepared.sha256}.json.gz`;
  const expectedIdentity = { ...identity,
    compressed_byte_size: prepared.byte_size, compressed_sha256: prepared.sha256,
    uncompressed_byte_size: prepared.json_byte_size, uncompressed_sha256: prepared.json_sha256 };
  const object = intent?.object;
  const headers = intent?.required_headers;
  const checksum = Buffer.from(prepared.sha256, 'hex').toString('base64');
  if (intent?.state !== 'signed_upload_intent' || !SHA.test(intent?.intent_id)
    || object?.bucket !== bucket || object?.key !== key || object?.sha256 !== prepared.sha256
    || object?.byte_size !== prepared.byte_size || object?.json_sha256 !== prepared.json_sha256
    || object?.json_byte_size !== prepared.json_byte_size
    || !intent.bundle_identity || JSON.stringify(intent.bundle_identity) !== JSON.stringify(expectedIdentity)
    || !headers || Object.keys(headers).length !== 3 || headers['Content-Type'] !== 'application/gzip'
    || headers['If-None-Match'] !== '*' || headers['x-amz-checksum-sha256'] !== checksum)
    throw failure('invalid_signer_response', 'Signer metadata differs from immutable evidence bundle');
  const validateUrl = (value, { readback = false } = {}) => {
    let url;
    try { url = new URL(value); } catch { throw failure('invalid_signer_response', 'Signer URL invalid'); }
    const date = url.searchParams.get('X-Amz-Date') || '';
    const signedAt = /^\d{8}T\d{6}Z$/.test(date)
      ? Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`) : NaN;
    const expiresAt = Date.parse(readback ? intent.readback_expires_at_utc : intent.expires_at_utc);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
    if (url.protocol !== 'https:' || url.hostname !== new URL(derivedTarget.endpoint).hostname
      || url.port || url.username || url.password || decodeURIComponent(url.pathname) !== `/${bucket}/${key}`
      || url.hash || url.searchParams.size !== 6
      || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
      || !new RegExp(`^[^/]+/${date.slice(0, 8)}/auto/s3/aws4_request$`).test(url.searchParams.get('X-Amz-Credential') || '')
      || url.searchParams.get('X-Amz-Expires') !== '60'
      || signedHeaders !== (readback ? 'host' : 'content-type;host;if-none-match;x-amz-checksum-sha256')
      || !SHA.test(url.searchParams.get('X-Amz-Signature') || '')
      || !Number.isFinite(signedAt) || !Number.isFinite(expiresAt) || expiresAt !== signedAt + 60_000
      || expiresAt < Date.now() + 1_000)
      throw failure('invalid_signer_response', 'Signer URL is unbound or expired');
    return url.href;
  };
  const id = pruneEvidenceBundleIntentId({ bucket, key, identity,
    compressed_byte_size: prepared.byte_size, compressed_sha256: prepared.sha256,
    uncompressed_byte_size: prepared.json_byte_size, uncompressed_sha256: prepared.json_sha256 });
  if (id !== intent.intent_id) throw failure('invalid_signer_response', 'Signer intent identity mismatch');
  return { intent_id: id, object, upload_url: validateUrl(intent.upload_url),
    readback_url: validateUrl(intent.readback_url, { readback: true }), required_headers: headers };
}

async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('bundle_readback_missing_body', 'Bundle readback has no body');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await reader.cancel().catch(() => {});
    throw failure('bundle_readback_size_mismatch', 'Bundle readback exceeds the declared size');
  }
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw failure('bundle_readback_size_mismatch', 'Bundle readback exceeds the declared size');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function uploadPruneEvidenceBundle({ signer, prepared, identity,
  fetchImpl = fetch, deadlineMs = PRUNE_EVIDENCE_BUNDLE_UPLOAD_DEADLINE_MS }) {
  const started = Date.now(); const endAt = started + deadlineMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const transport = { signer_intent_state: 'not_attempted', put_state: 'not_attempted',
    readback_state: 'not_attempted', duration_ms: null };
  try {
    if (!prepared || !Buffer.isBuffer(prepared.body)
      || prepared.byte_size !== prepared.body.length
      || prepared.byte_size > PRUNE_EVIDENCE_BUNDLE_LIMITS.compressed_bytes
      || prepared.json_byte_size > PRUNE_EVIDENCE_BUNDLE_LIMITS.json_bytes
      || identity?.writer_identity !== 'prune_daily_v3' || identity.connector_id !== 1)
      throw failure('invalid_evidence_bundle', 'Evidence bundle is outside its bounded writer contract');
    const request = { ...identity,
      compressed_byte_size: prepared.byte_size, compressed_sha256: prepared.sha256,
      uncompressed_byte_size: prepared.json_byte_size, uncompressed_sha256: prepared.json_sha256 };
    let response;
    transport.signer_intent_state = 'ambiguous';
    try { response = await fetchImpl(signer.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${signer.writerToken}`, 'Content-Type': 'application/json',
        'CF-Access-Client-Id': signer.accessId, 'CF-Access-Client-Secret': signer.accessSecret },
      body: JSON.stringify(request) }); }
    catch { throw failure(controller.signal.aborted ? 'bundle_deadline' : 'signer_transport_unavailable',
      'Evidence bundle signer request did not complete'); }
    if (!response.ok) {
      transport.signer_intent_state = 'rejected';
      const code = [401, 403].includes(response.status) ? 'signer_auth_rejected'
        : response.status === 429 ? 'signer_rate_limited'
          : response.status >= 500 ? 'signer_unavailable' : 'signer_rejected';
      await response.body?.cancel().catch(() => {});
      throw failure(code, `Signer returned HTTP ${response.status}`);
    }
    const intent = validateBundleIntent(await boundedJson(response), prepared, identity, signer.derivedTarget);
    transport.signer_intent_state = 'accepted';
    if (Date.now() >= endAt) throw failure('bundle_deadline', 'Evidence bundle deadline exceeded before PUT');
    let put;
    transport.put_state = 'ambiguous';
    try { put = await fetchImpl(intent.upload_url, { method: 'PUT', redirect: 'error', signal: controller.signal,
      headers: intent.required_headers, body: prepared.body }); }
    catch { if (controller.signal.aborted) throw failure('bundle_deadline', 'Evidence bundle PUT exceeded deadline'); }
    if (put) {
      if ((put.status < 200 || put.status >= 300) && ![409, 412].includes(put.status)
        && put.status < 500) {
        transport.put_state = 'rejected';
        await put.body?.cancel().catch(() => {});
        throw failure('bundle_put_rejected', `Evidence bundle PUT returned HTTP ${put.status}`);
      }
      transport.put_state = put.status >= 200 && put.status < 300 ? 'acknowledged' : 'ambiguous';
      await put.body?.cancel().catch(() => {});
    }
    if (controller.signal.aborted || Date.now() >= endAt)
      throw failure('bundle_deadline', 'Evidence bundle deadline exceeded before readback');
    transport.readback_state = 'ambiguous';
    let readback;
    try { readback = await fetchImpl(intent.readback_url, { method: 'GET', redirect: 'error', signal: controller.signal }); }
    catch { throw failure(controller.signal.aborted ? 'bundle_deadline' : 'bundle_readback_unavailable',
      'Evidence bundle readback did not complete'); }
    if (!readback.ok) {
      await readback.body?.cancel().catch(() => {});
      throw failure(readback.status === 404 ? 'bundle_readback_missing' : 'bundle_readback_unavailable',
        `Evidence bundle readback returned HTTP ${readback.status}`);
    }
    const bytes = await readBounded(readback, prepared.byte_size);
    if (controller.signal.aborted || Date.now() >= endAt)
      throw failure('bundle_deadline', 'Evidence bundle readback exceeded deadline');
    if (bytes.length !== prepared.byte_size || !bytes.equals(prepared.body)
      || sha256Hex(bytes) !== prepared.sha256)
      throw failure('bundle_readback_mismatch', 'Evidence bundle readback differs from prepared bytes');
    transport.readback_state = 'verified';
    transport.duration_ms = Math.max(0, Date.now() - started);
    return { ...identity, intent_id: intent.intent_id, bucket: intent.object.bucket,
      key: intent.object.key, compressed_sha256: intent.object.sha256,
      compressed_byte_size: intent.object.byte_size, uncompressed_sha256: intent.object.json_sha256,
      uncompressed_byte_size: intent.object.json_byte_size, transport };
  } catch (error) {
    transport.duration_ms = Math.max(0, Date.now() - started);
    if (!error.code) error.code = controller.signal.aborted ? 'bundle_deadline' : 'bundle_retention_failed';
    error.transport = transport;
    throw error;
  } finally { clearTimeout(timer); }
}
