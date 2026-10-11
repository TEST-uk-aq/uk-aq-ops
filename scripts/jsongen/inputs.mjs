// Bounded, read-only immutable managed input authentication. Digests prove bytes,
// not a writer's final publication or current canonical authority.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { buildAwsSignedRequest, fetchWithTimeout, sha256Hex } from '../../workers/shared/r2_sigv4.mjs';
import { BUCKET, ROOT, assertReference, assertReceipt, assertBundleRecords,
  canonicalJson, requireValid } from './schema.mjs';

export const INPUT_LIMITS = Object.freeze({ receipt_bytes: 256 * 1024,
  compressed_bytes: 16 * 1024 * 1024, uncompressed_bytes: 64 * 1024 * 1024,
  scopes: 128, rows: 500_000, records: 128, request_ms: 30_000 });
const decoder = new TextDecoder('utf-8', { fatal: true });
const hash = (body) => createHash('sha256').update(body).digest('hex');

export async function readBoundedObject({ r2, key, maxBytes, expectedBucket = BUCKET,
  timeoutMs = INPUT_LIMITS.request_ms }) {
  requireValid(r2?.bucket === expectedBucket && typeof expectedBucket === 'string'
    && expectedBucket.length > 0 && typeof key === 'string' && key.length > 0,
    'expected bucket and exact object key required');
  requireValid(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= INPUT_LIMITS.uncompressed_bytes,
    'invalid read limit');
  requireValid(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= INPUT_LIMITS.request_ms,
    'invalid request timeout');
  let body;
  if (r2.adapter) {
    requireValid(typeof r2.adapter.getObjectBounded === 'function', 'bounded read adapter required');
    const result = await r2.adapter.getObjectBounded({ key, maxBytes, timeoutMs });
    body = result?.body;
    requireValid(body instanceof Uint8Array && body.byteLength === result.bytes,
      'bounded adapter returned invalid length');
  } else {
    if (expectedBucket === BUCKET) requireValid(r2.endpoint ===
      'https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com',
    'approved private derived endpoint required');
    requireValid(typeof r2.endpoint === 'string' && r2.endpoint.startsWith('https://')
      && r2.region && r2.access_key_id && r2.secret_access_key, 'signed R2 read configuration required');
    const request = buildAwsSignedRequest({ method: 'GET', endpoint: r2.endpoint,
      region: r2.region, accessKeyId: r2.access_key_id, secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket, objectKey: key });
    body = await fetchWithTimeout(request.url, { method: 'GET', headers: request.headers },
      timeoutMs, globalThis.fetch, async (response) => {
        if (!response.ok) {
          const error = new Error(`R2 GET failed (${response.status}) key=${key}`);
          error.status = response.status;
          throw error;
        }
        const declared = response.headers.get('content-length');
        if (declared !== null) requireValid(/^\d+$/.test(declared) && Number(declared) <= maxBytes,
          'R2 object exceeds read limit');
        requireValid(response.body, 'R2 GET returned no body');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new Error('JSONgen: R2 object exceeds read limit');
          chunks.push(chunk);
        }
        requireValid(declared === null || bytes === Number(declared), 'R2 content-length mismatch');
        return Buffer.concat(chunks, bytes);
      });
  }
  requireValid(body.byteLength <= maxBytes, 'R2 object exceeds read limit');
  return Buffer.from(body);
}

export async function readImmutableReceipt({ r2, reference }) {
  assertReference(reference, { managed: true });
  requireValid(reference.bucket === BUCKET && reference.byte_size <= INPUT_LIMITS.receipt_bytes
    && reference.key === `${ROOT}/receipts/${reference.sha256}.json`, 'invalid immutable receipt reference');
  const body = await readBoundedObject({ r2, key: reference.key, maxBytes: INPUT_LIMITS.receipt_bytes });
  requireValid(body.length === reference.byte_size && hash(body) === reference.sha256,
    'receipt byte identity mismatch');
  const receipt = assertReceipt(JSON.parse(decoder.decode(body)));
  requireValid(body.equals(canonicalJson(receipt)), 'receipt JSON is not canonical');
  requireValid(receipt.scopes.length <= INPUT_LIMITS.scopes
    && receipt.bundle.row_count <= INPUT_LIMITS.rows, 'receipt scope/row limit exceeded');
  return { receipt, reference, bytes_verified: true, writer_authentication: 'unavailable' };
}

export async function readCompleteScopeBundle({ r2, receipt }) {
  assertReceipt(receipt);
  requireValid(receipt.scopes.length <= INPUT_LIMITS.scopes
    && receipt.bundle.row_count <= INPUT_LIMITS.rows, 'bundle scope/row limit exceeded');
  const ref = receipt.bundle.object;
  requireValid(ref.bucket === BUCKET && ref.key === `${ROOT}/bundles/${ref.sha256}.ndjson.gz`
    && ref.byte_size <= INPUT_LIMITS.compressed_bytes
    && ref.json_byte_size <= INPUT_LIMITS.uncompressed_bytes, 'invalid immutable bundle reference/limit');
  const compressed = await readBoundedObject({ r2, key: ref.key,
    maxBytes: INPUT_LIMITS.compressed_bytes });
  requireValid(compressed.length === ref.byte_size && sha256Hex(compressed) === ref.sha256,
    'compressed bundle byte identity mismatch');
  const plain = gunzipSync(compressed, { maxOutputLength: INPUT_LIMITS.uncompressed_bytes });
  requireValid(plain.length === ref.json_byte_size && sha256Hex(plain) === ref.json_sha256,
    'uncompressed bundle byte identity mismatch');
  const content = decoder.decode(plain);
  requireValid(content.endsWith('\n') && !content.includes('\r') && !content.includes('\n\n'),
    'invalid NDJSON framing');
  const lines = content.slice(0, -1).split('\n');
  requireValid(lines.length <= INPUT_LIMITS.records && lines.length === refRecordCount(receipt),
    'bundle record count mismatch');
  const records = lines.map((line) => JSON.parse(line));
  assertBundleRecords(records, receipt);
  return { records, reference: ref, compressed_bytes_verified: true,
    uncompressed_bytes_verified: true, complete_scopes_validated: true,
    writer_authentication: 'unavailable' };
}

function refRecordCount(receipt) { return receipt.bundle.scope_count; }
