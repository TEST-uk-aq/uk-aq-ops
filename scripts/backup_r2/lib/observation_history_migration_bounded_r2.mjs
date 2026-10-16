import { Buffer } from 'node:buffer';
import { buildAwsSignedRequest, fetchWithTimeout, R2_REQUEST_TIMEOUT_MS } from '../../../workers/shared/r2_sigv4.mjs';

// Migration-local bounded GET. The shared signer and timeout fetch are present
// in both TEST and LIVE; the shared bounded-GET export is not yet present in LIVE.
export async function r2GetMigrationObjectBounded({ r2, key, max_bytes, timeout_ms = R2_REQUEST_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(max_bytes) || max_bytes <= 0 ||
      !Number.isSafeInteger(timeout_ms) || timeout_ms <= 0 || timeout_ms > R2_REQUEST_TIMEOUT_MS) {
    throw new TypeError('Bounded R2 GET requires positive byte and timeout budgets');
  }
  const validate = (stored) => {
    if (!(stored?.body instanceof Uint8Array) || stored.body.byteLength > max_bytes ||
        stored.bytes !== stored.body.byteLength) {
      throw new Error('Bounded R2 GET body/size mismatch or byte budget exceeded');
    }
    return { ...stored, key, body: Buffer.from(stored.body) };
  };
  if (r2?.adapter) {
    if (typeof r2.adapter.getObjectBounded !== 'function') {
      throw new TypeError('R2 adapter must implement getObjectBounded');
    }
    const controller = new AbortController();
    let timer;
    try {
      return validate(await Promise.race([
        r2.adapter.getObjectBounded({ key, max_bytes, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Bounded R2 GET deadline exceeded'));
        }, timeout_ms); }),
      ]));
    } finally { clearTimeout(timer); }
  }
  const request = buildAwsSignedRequest({ method: 'GET', endpoint: r2.endpoint,
    region: r2.region, accessKeyId: r2.access_key_id, secretAccessKey: r2.secret_access_key,
    bucket: r2.bucket, objectKey: key });
  return await fetchWithTimeout(request.url, {
    method: 'GET', headers: request.headers, redirect: 'error',
  }, timeout_ms, globalThis.fetch, async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Bounded R2 GET failed (${response.status}) key=${key}`);
      error.status = response.status;
      throw error;
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) ||
        !Number.isSafeInteger(Number(declared)) || Number(declared) > max_bytes)) {
      await response.body?.cancel();
      throw new Error('Bounded R2 GET content length exceeds byte budget');
    }
    if (!response.body) throw new Error('Bounded R2 GET response body missing');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > max_bytes) throw new Error('Bounded R2 GET byte budget exceeded');
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (declared !== null && Number(declared) !== bytes) {
      throw new Error('Bounded R2 GET content length mismatch');
    }
    return validate({ body: Buffer.concat(chunks, bytes), bytes,
      etag: response.headers.get('etag') || null });
  });
}
