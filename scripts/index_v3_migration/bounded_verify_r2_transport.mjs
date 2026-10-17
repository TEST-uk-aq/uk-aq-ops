import {
  buildAwsSignedRequest,
  fetchWithTimeout,
  isRetryableR2Status,
  normalizeR2Sha256Checksum,
  R2_REQUEST_MAX_ATTEMPTS,
  R2_REQUEST_RETRY_DELAYS_MS,
  R2_REQUEST_TIMEOUT_MS,
} from '../../workers/shared/r2_sigv4.mjs';
import { r2GetMigrationObjectBounded } from '../backup_r2/lib/observation_history_migration_bounded_r2.mjs';

const EXPECTED_RETRY_DELAYS_MS = [500, 1000, 2000];
const REQUEST_ERROR_CAUSE_MAX_DEPTH = 8;
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_ERROR_TOKENS = [
  'connection reset',
  'connection closed',
  'broken pipe',
  'socket hang up',
  'socket closed',
  'socket reset',
  'econnreset',
  'econnrefused',
  'ehostunreach',
  'enetunreach',
  'etimedout',
  'timed out',
  'timeout',
  'networkerror',
  'network error',
  'sendrequest',
  'temporarily unavailable',
  'tls',
  'eof',
];

if (R2_REQUEST_MAX_ATTEMPTS !== 4 || R2_REQUEST_TIMEOUT_MS !== 30_000 ||
    R2_REQUEST_RETRY_DELAYS_MS.length !== EXPECTED_RETRY_DELAYS_MS.length ||
    R2_REQUEST_RETRY_DELAYS_MS.some((delay, index) => delay !== EXPECTED_RETRY_DELAYS_MS[index])) {
  throw new Error('Shared R2 request limits differ from the bounded verifier transport contract');
}

function errorField(error, field) {
  try {
    const value = error?.[field];
    return typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  } catch {
    return '';
  }
}

// This private classifier mirrors the common TEST/LIVE transport cases without
// depending on TEST's newer isRetryableR2RequestError export.
function isRetryableTransportError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < REQUEST_ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const isObject = current !== null &&
      (typeof current === 'object' || typeof current === 'function');
    if (isObject) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const name = isObject ? errorField(current, 'name') : '';
    const message = isObject
      ? errorField(current, 'message')
      : String(current ?? '').trim();
    const code = isObject ? errorField(current, 'code') : '';
    if (RETRYABLE_ERROR_CODES.has(code.toUpperCase())) return true;
    if (name.toLowerCase() === 'typeerror' && message.toLowerCase() === 'fetch failed') return true;
    const description = `${name} ${message} ${code}`.toLowerCase();
    if (RETRYABLE_ERROR_TOKENS.some((token) => description.includes(token))) return true;
    if (!isObject) break;
    try {
      current = current.cause;
    } catch {
      break;
    }
    if (current === null || current === undefined) break;
  }
  return false;
}

function isRetryableBoundedFailure(error) {
  if (Number.isInteger(error?.status)) return isRetryableR2Status(error.status);
  if (error?.code === 'R2_INTEGRITY') return false;
  if (error?.message === 'Bounded R2 GET deadline exceeded') return true;
  return isRetryableTransportError(error);
}

function integrityError(message, key) {
  const error = new Error(`${message}: ${key}`);
  error.code = 'R2_INTEGRITY';
  return error;
}

function responseStatusError(method, key, status) {
  const error = new Error(`Bounded R2 ${method} failed (${status}) key=${key}`);
  error.status = status;
  error.code = `HTTP_${status}`;
  return error;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Disposal is best effort; the request timeout still bounds this attempt.
  }
}

function parseContentLength(value, key) {
  if (value === null) return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) throw integrityError('R2 HEAD Content-Length is malformed', key);
  const bytes = Number(normalized);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw integrityError('R2 HEAD Content-Length is outside the safe integer range', key);
  }
  return bytes;
}

function normalizeHeadResult({ key, exists, bytes, sha256, etag = null, last_modified = null }) {
  if (exists === false) return { exists: false, key };
  if (exists !== true) throw integrityError('R2 HEAD did not establish object existence', key);
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw integrityError('R2 HEAD object size is invalid', key);
  }
  return {
    exists: true,
    key,
    etag: etag ? String(etag) : null,
    last_modified: last_modified ? String(last_modified) : null,
    bytes,
    sha256,
  };
}

function validateAdapterHeadResult(result, key) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw integrityError('R2 HEAD adapter returned a malformed result', key);
  }
  if (result.key !== undefined && result.key !== key) {
    throw integrityError('R2 HEAD adapter returned a contradictory object key', key);
  }
  if (result.exists === false) return { exists: false, key };
  const rawBytes = result.bytes ?? result.size;
  let bytes = null;
  if (rawBytes !== null && rawBytes !== undefined && rawBytes !== '') {
    const normalizedBytes = typeof rawBytes === 'number' ? rawBytes : String(rawBytes).trim();
    if (typeof normalizedBytes === 'string' && !/^\d+$/.test(normalizedBytes)) {
      throw integrityError('R2 HEAD adapter returned malformed object size', key);
    }
    bytes = Number(normalizedBytes);
  }
  const rawSha256 = result.sha256 ?? result.checksums?.sha256;
  const sha256 = normalizeR2Sha256Checksum(rawSha256);
  if (rawSha256 !== null && rawSha256 !== undefined && rawSha256 !== '' && !sha256) {
    throw integrityError('R2 HEAD adapter returned malformed SHA-256 metadata', key);
  }
  return normalizeHeadResult({
    key,
    exists: result.exists,
    bytes,
    sha256,
    etag: result.etag ?? result.httpEtag ?? null,
    last_modified: result.last_modified ?? result.lastModified ?? null,
  });
}

async function headAdapterOnce({ r2, key }) {
  if (typeof r2?.adapter?.headObject !== 'function') {
    throw new TypeError('R2 adapter must implement headObject for bounded verifier HEAD');
  }
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => r2.adapter.headObject({
        key,
        signal: controller.signal,
        accept_encoding_identity: true,
        checksum_mode: 'ENABLED',
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`HEAD request timed out after ${R2_REQUEST_TIMEOUT_MS}ms`);
          error.code = 'ETIMEDOUT';
          reject(error);
        }, R2_REQUEST_TIMEOUT_MS);
      }),
    ]);
    return validateAdapterHeadResult(result, key);
  } finally {
    clearTimeout(timer);
  }
}

async function headSignedOnce({ r2, key }) {
  const request = buildAwsSignedRequest({
    method: 'HEAD',
    endpoint: r2.endpoint,
    region: r2.region,
    accessKeyId: r2.access_key_id,
    secretAccessKey: r2.secret_access_key,
    bucket: r2.bucket,
    objectKey: key,
    headers: {
      'x-amz-checksum-mode': 'ENABLED',
      'accept-encoding': 'identity',
    },
  });
  return await fetchWithTimeout(request.url, {
    method: 'HEAD',
    headers: request.headers,
    redirect: 'error',
  }, R2_REQUEST_TIMEOUT_MS, globalThis.fetch, async (response) => {
    if (response.status === 404) {
      await cancelResponseBody(response);
      return { exists: false, key };
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw responseStatusError('HEAD', key, response.status);
    }
    const bytes = parseContentLength(response.headers.get('content-length'), key);
    const rawSha256 = response.headers.get('x-amz-checksum-sha256');
    const sha256 = normalizeR2Sha256Checksum(rawSha256);
    if (rawSha256 !== null && !sha256) {
      throw integrityError('R2 HEAD SHA-256 metadata is malformed', key);
    }
    return normalizeHeadResult({
      key,
      exists: true,
      bytes,
      sha256,
      etag: response.headers.get('etag') || null,
      last_modified: response.headers.get('last-modified') || null,
    });
  });
}

async function withBoundedRetry({ method, key, assertHeld, attempt }) {
  let lastError;
  for (let number = 1; number <= R2_REQUEST_MAX_ATTEMPTS; number += 1) {
    assertHeld();
    let value;
    let failed = false;
    try {
      value = await attempt();
    } catch (error) {
      lastError = error;
      failed = true;
    }
    // A lost lock takes precedence over a transient error; it must never retry.
    assertHeld();
    if (!failed) {
      assertHeld();
      return value;
    }
    if (!isRetryableBoundedFailure(lastError)) throw lastError;
    if (number === R2_REQUEST_MAX_ATTEMPTS) {
      const status = Number.isInteger(lastError?.status) ? lastError.status : null;
      const statusText = status === null ? '' : ` HTTP ${status}`;
      const detail = lastError?.message ? `: ${lastError.message}` : '';
      const exhausted = new Error(
        `Bounded verifier R2 ${method} exhausted after ${number} attempts: key=${key}${statusText}${detail}`,
        { cause: lastError },
      );
      if (status !== null) exhausted.status = status;
      throw exhausted;
    }
    const delay = R2_REQUEST_RETRY_DELAYS_MS[number - 1];
    assertHeld();
    await new Promise((resolve) => setTimeout(resolve, delay));
    assertHeld();
  }
  throw new Error(`Bounded verifier R2 ${method} retry loop exhausted unexpectedly: key=${key}`, {
    cause: lastError,
  });
}

export function createBoundedVerifierR2Transport({ r2, assertHeld }) {
  if (typeof assertHeld !== 'function') {
    throw new TypeError('Bounded verifier R2 transport requires the supervised lock assertion');
  }
  return Object.freeze({
    getObject: async ({ key, max_bytes }) => withBoundedRetry({
      method: 'GET',
      key,
      assertHeld,
      attempt: async () => {
        const result = await r2GetMigrationObjectBounded({
          r2,
          key,
          max_bytes,
          timeout_ms: R2_REQUEST_TIMEOUT_MS,
        });
        if (!(result?.body instanceof Uint8Array) || result.key !== key ||
            result.body.byteLength !== result.bytes || result.bytes > max_bytes) {
          throw integrityError('Bounded R2 GET response identity or byte count is invalid', key);
        }
        return result;
      },
    }),
    headObject: async ({ key }) => withBoundedRetry({
      method: 'HEAD',
      key,
      assertHeld,
      attempt: () => r2?.adapter
        ? headAdapterOnce({ r2, key })
        : headSignedOnce({ r2, key }),
    }),
  });
}
