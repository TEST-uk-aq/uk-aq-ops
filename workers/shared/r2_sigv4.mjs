import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";

const R2_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
export const R2_REQUEST_MAX_ATTEMPTS = 4;
export const R2_REQUEST_RETRY_BASE_MS = 500;
export const R2_REQUEST_RETRY_MAX_MS = 5000;
export const R2_REQUEST_TIMEOUT_MS = 30_000;
export const R2_PUBLICATION_SAFETY_MARGIN_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = R2_REQUEST_TIMEOUT_MS;

export const R2_REQUEST_RETRY_DELAYS_MS = Object.freeze(
  Array.from({ length: Math.max(0, R2_REQUEST_MAX_ATTEMPTS - 1) }, (_, index) =>
    Math.min(
      R2_REQUEST_RETRY_MAX_MS,
      R2_REQUEST_RETRY_BASE_MS * (2 ** index),
    )
  ),
);
export const R2_REQUEST_WORST_CASE_DURATION_MS =
  // Four complete request-and-response-body attempts plus 500+1000+2000ms backoff.
  (R2_REQUEST_MAX_ATTEMPTS * R2_REQUEST_TIMEOUT_MS) +
  R2_REQUEST_RETRY_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
export const R2_CHECKSUM_PUT_HEAD_WORST_CASE_DURATION_MS =
  // One complete checksum-aware object is PUT followed by HEAD verification.
  (2 * R2_REQUEST_WORST_CASE_DURATION_MS) + R2_PUBLICATION_SAFETY_MARGIN_MS;
const R2_REQUEST_ERROR_CAUSE_MAX_DEPTH = 8;
const R2_RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const R2_RETRYABLE_ERROR_TOKENS = [
  "connection reset",
  "connection closed",
  "broken pipe",
  "socket hang up",
  "socket closed",
  "socket reset",
  "econnreset",
  "econnrefused",
  "ehostunreach",
  "enetunreach",
  "etimedout",
  "timed out",
  "timeout",
  "networkerror",
  "network error",
  "sendrequest",
  "temporarily unavailable",
  "tls",
  "eof",
];

export function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function awsSha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeR2Sha256Checksum(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return bytes.byteLength === 32 ? bytes.toString("hex") : null;
  }
  const text = String(value).trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.byteLength === 32 && bytes.toString("base64") === text
    ? bytes.toString("hex")
    : null;
}

function sha256HexToBase64(value) {
  const normalized = normalizeR2Sha256Checksum(value);
  if (!normalized) throw new Error("R2 SHA-256 checksum must be 64 hex characters");
  return Buffer.from(normalized, "hex").toString("base64");
}

function awsHmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function awsSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = awsHmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = awsHmac(kDate, region);
  const kService = awsHmac(kRegion, service);
  return awsHmac(kService, "aws4_request");
}

function buildCanonicalQuery(query) {
  const pairs = [];
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    pairs.push([encodeRfc3986(key), encodeRfc3986(String(value))]);
  }
  pairs.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1].localeCompare(b[1]);
    }
    return a[0].localeCompare(b[0]);
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function buildAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function normalizeHeaders(headers = {}) {
  const pairs = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const name = String(rawName).trim().toLowerCase();
    if (!name) {
      continue;
    }
    const value = String(rawValue).trim().replace(/\s+/g, " ");
    pairs.push([name, value]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return pairs;
}

export function buildAwsSignedRequest({
  method,
  endpoint,
  region,
  accessKeyId,
  secretAccessKey,
  bucket,
  objectKey,
  query = {},
  headers = {},
  payloadHash,
}) {
  const endpointUrl = new URL(endpoint);
  const host = endpointUrl.host;
  const service = "s3";
  const now = new Date();
  const amzDate = buildAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const pathParts = ["", bucket];
  if (objectKey) {
    for (const part of objectKey.split("/").filter(Boolean)) {
      pathParts.push(encodeRfc3986(part));
    }
  }
  const canonicalUri = pathParts.join("/") || "/";
  const canonicalQuery = buildCanonicalQuery(query);
  const bodyHash = payloadHash || awsSha256Hex("");

  const canonicalHeaderPairs = normalizeHeaders({
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
    ...headers,
  });

  const canonicalHeaders = canonicalHeaderPairs
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
  const signedHeaders = canonicalHeaderPairs
    .map(([name]) => name)
    .join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    awsSha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = awsSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  const requestUrl = new URL(endpoint);
  requestUrl.pathname = canonicalUri;
  requestUrl.search = canonicalQuery;

  const requestHeaders = {
    ...Object.fromEntries(canonicalHeaderPairs),
    authorization,
  };

  return {
    url: requestUrl.toString(),
    headers: requestHeaders,
    payload_hash: bodyHash,
  };
}

export function hasRequiredR2Config(r2) {
  return Boolean(
    r2
    && r2.endpoint
    && r2.bucket
    && r2.region
    && r2.access_key_id
    && r2.secret_access_key,
  );
}

export function normalizePrefix(rawPrefix) {
  return String(rawPrefix || "").trim().replace(/^\/+|\/+$/g, "");
}

export async function readResponseText(response, limit = 2000) {
  const raw = await response.text();
  return raw.length <= limit ? raw : raw.slice(0, limit);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(
  url,
  init = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  consumeResponse = null,
) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(init.signal.reason);
  if (init.signal?.aborted) abortFromCaller();
  else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const method = String(init.method || "GET").toUpperCase();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, boundedTimeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    return typeof consumeResponse === "function"
      ? await consumeResponse(response)
      : response;
  } catch (error) {
    if (timedOut) {
      let target = "external service";
      try {
        const parsed = new URL(url);
        target = `${parsed.origin}${parsed.pathname}`;
      } catch {
        // Keep the generic target rather than exposing an unparseable URL.
      }
      throw new Error(
        `${method} request to ${target} timed out after ${boundedTimeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function isRetryableR2Status(status) {
  return R2_RETRYABLE_STATUS_CODES.has(status);
}

function r2RequestErrorField(error, field) {
  try {
    const value = error?.[field];
    return typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  } catch {
    return "";
  }
}

export function isRetryableR2RequestError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < R2_REQUEST_ERROR_CAUSE_MAX_DEPTH; depth += 1) {
    const isObject = (
      current !== null &&
      (typeof current === "object" || typeof current === "function")
    );
    if (isObject) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const name = isObject ? r2RequestErrorField(current, "name") : "";
    const message = isObject
      ? r2RequestErrorField(current, "message")
      : String(current ?? "").trim();
    const code = isObject ? r2RequestErrorField(current, "code") : "";
    if (R2_RETRYABLE_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }
    // Node/Undici uses this exact TypeError as its generic transport wrapper,
    // including when the underlying cause was not preserved by the caller.
    if (name.toLowerCase() === "typeerror" && message.toLowerCase() === "fetch failed") {
      return true;
    }
    const description = `${name} ${message} ${code}`.toLowerCase();
    if (R2_RETRYABLE_ERROR_TOKENS.some((token) => description.includes(token))) {
      return true;
    }
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

function computeR2RetryDelayMs(attempt) {
  return Math.min(
    R2_REQUEST_RETRY_MAX_MS,
    R2_REQUEST_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
  );
}

function cancelResponseBody(response) {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === "function") {
      void cancelled.catch(() => {});
    }
  } catch {
    // A retry does not depend on best-effort disposal of the failed response.
  }
}

async function fetchR2WithRetry({
  method,
  buildRequest,
  body = undefined,
  consumeResponse = null,
  maxAttempts = R2_REQUEST_MAX_ATTEMPTS,
  assertHeld = null,
}) {
  const boundedMaxAttempts = Number.isSafeInteger(Number(maxAttempts))
    && Number(maxAttempts) > 0
    ? Number(maxAttempts)
    : R2_REQUEST_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= boundedMaxAttempts; attempt += 1) {
    assertHeld?.();
    const request = buildRequest();
    let attemptResult, attemptFailed = false;
    try {
      attemptResult = await fetchWithTimeout(
        request.url,
        {
          method,
          headers: request.headers,
          body,
        },
        R2_REQUEST_TIMEOUT_MS,
        globalThis.fetch,
        async (response) => {
          if (
            isRetryableR2Status(response.status) &&
            attempt < boundedMaxAttempts
          ) {
            cancelResponseBody(response);
            return { retry: true, value: null };
          }
          return {
            retry: false,
            value: typeof consumeResponse === "function"
              ? await consumeResponse(response)
              : response,
          };
        },
      );
    } catch (error) {
      assertHeld?.();
      if (
        !isRetryableR2RequestError(error) ||
        attempt === boundedMaxAttempts
      ) {
        throw error;
      }
      attemptFailed = true;
    }
    if (!attemptFailed) {
      assertHeld?.();
      if (!attemptResult.retry) {
        return attemptResult.value;
      }
    }
    assertHeld?.();
    await sleep(computeR2RetryDelayMs(attempt));
    assertHeld?.();
  }

  throw new Error("R2 request retry loop exhausted unexpectedly.");
}

export async function r2PutObject({
  r2,
  key,
  body,
  content_type = "application/octet-stream",
  sha256 = null,
}) {
  const expectedSha256 = normalizeR2Sha256Checksum(sha256);
  if (sha256 !== null && !expectedSha256) {
    throw new Error(`R2 PUT SHA-256 is invalid: ${key}`);
  }
  if (expectedSha256 && awsSha256Hex(body) !== expectedSha256) {
    throw new Error(`R2 PUT body SHA-256 mismatch: ${key}`);
  }
  if (r2?.adapter?.putObject) {
    return r2.adapter.putObject({
      key,
      body,
      content_type,
      ...(expectedSha256 ? { sha256: expectedSha256 } : {}),
    });
  }
  const bufferBody = body instanceof Uint8Array ? body : Buffer.from(body);
  const payloadHash = createHash("sha256").update(bufferBody).digest("hex");
  const { response, errorText } = await fetchR2WithRetry({
    method: "PUT",
    body: bufferBody,
    buildRequest: () => buildAwsSignedRequest({
      method: "PUT",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: key,
      payloadHash,
      headers: {
        "content-type": content_type,
        "content-length": String(bufferBody.byteLength),
        ...(expectedSha256
          ? { "x-amz-checksum-sha256": sha256HexToBase64(expectedSha256) }
          : {}),
      },
    }),
    consumeResponse: async (response) => ({
      response,
      errorText: response.ok ? "" : await readResponseText(response, 4000),
    }),
  });
  if (!response.ok) {
    throw new Error(`R2 PUT failed (${response.status}) key=${key}: ${errorText}`);
  }

  return {
    key,
    bytes: bufferBody.byteLength,
    etag: response.headers.get("etag") || null,
    sha256: normalizeR2Sha256Checksum(
      response.headers.get("x-amz-checksum-sha256"),
    ) || expectedSha256,
  };
}

// Separate from r2PutObject: a conditional attempt must NEVER enter its retry
// loop or fall through to an adapter's unconditional putObject method.
export class R2ConditionalWriteError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = "R2ConditionalWriteError";
    this.code = code;
    this.status = status;
  }
}

export function isStrongR2Etag(value) {
  return typeof value === "string" && /^"[^"\s\x00-\x1f\x7f]+"$/.test(value);
}

export async function r2PutObjectConditional({
  r2, key, body, if_match = null, if_none_match = null,
  content_type = "application/octet-stream", sha256 = null,
}) {
  if (!((isStrongR2Etag(if_match) && if_none_match === null)
    || (if_match === null && if_none_match === "*"))) {
    throw new TypeError("Conditional PUT requires one strong quoted ETag or If-None-Match: *");
  }
  const bufferBody = body instanceof Uint8Array ? body : Buffer.from(body);
  const payloadHash = awsSha256Hex(bufferBody);
  if (sha256 !== null && normalizeR2Sha256Checksum(sha256) !== payloadHash) {
    throw new TypeError("Conditional PUT body SHA-256 mismatch");
  }
  if (r2?.adapter && typeof r2.adapter.putObjectConditional !== "function") {
    throw new TypeError("R2 adapter does not implement atomic putObjectConditional");
  }
  let request;
  if (!r2?.adapter) {
    request = buildAwsSignedRequest({
      method: "PUT", endpoint: r2.endpoint, region: r2.region,
      accessKeyId: r2.access_key_id, secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket, objectKey: key, payloadHash,
      headers: {
        "content-type": content_type, "content-length": String(bufferBody.byteLength),
        "x-amz-checksum-sha256": sha256HexToBase64(payloadHash),
        ...(if_match !== null ? { "if-match": if_match } : { "if-none-match": "*" }),
      },
    });
  }
  let result;
  try {
    // Adapter contract: one attempt, {status, etag}; thrown errors are ambiguous.
    result = r2?.adapter
      ? await r2.adapter.putObjectConditional({ key, body: bufferBody,
        content_type, sha256: payloadHash, if_match, if_none_match })
      : await fetchWithTimeout(request.url,
        { method: "PUT", headers: request.headers, body: bufferBody },
        R2_REQUEST_TIMEOUT_MS, globalThis.fetch, async (response) => {
          const outcome = { status: response.status, etag: response.headers.get("etag") };
          cancelResponseBody(response);
          return outcome;
        });
  } catch (cause) {
    throw new R2ConditionalWriteError("R2_WRITE_AMBIGUOUS",
      "Conditional PUT transport failure; inspect authoritative object before retry", { cause });
  }
  const status = result?.status;
  if (status === 412) {
    throw new R2ConditionalWriteError("R2_PRECONDITION_FAILED",
      "Conditional PUT precondition failed; reread current state", { status });
  }
  // 409 includes concurrent-operation conflicts. Treat conservatively, as with
  // timeout/service failures and malformed/missing success evidence.
  if (status === 409 || isRetryableR2Status(status) || status >= 500
    || !Number.isInteger(status) || status < 100 || status > 599
    || (status >= 200 && status < 300 && !isStrongR2Etag(result.etag))) {
    throw new R2ConditionalWriteError("R2_WRITE_AMBIGUOUS",
      "Conditional PUT outcome unknown; inspect authoritative object before retry", { status });
  }
  if (status < 200 || status >= 300) {
    throw new R2ConditionalWriteError("R2_SERVICE_FAILURE", "Conditional PUT rejected", { status });
  }
  return { key, bytes: bufferBody.byteLength, etag: result.etag, sha256: payloadHash };
}

export async function r2CopyObject({ r2, source_key, dest_key }) {
  const copySource = `/${r2.bucket}/${source_key.split("/").map((part) => encodeRfc3986(part)).join("/")}`;
  const { response, errorText } = await fetchR2WithRetry({
    method: "PUT",
    buildRequest: () => buildAwsSignedRequest({
      method: "PUT",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: dest_key,
      headers: {
        "x-amz-copy-source": copySource,
      },
    }),
    consumeResponse: async (response) => ({
      response,
      errorText: response.ok ? "" : await readResponseText(response, 4000),
    }),
  });
  if (!response.ok) {
    throw new Error(`R2 COPY failed (${response.status}) ${source_key} -> ${dest_key}: ${errorText}`);
  }

  return {
    source_key,
    dest_key,
    etag: response.headers.get("etag") || null,
  };
}

export async function r2HeadObject({ r2, key, accept_encoding_identity = false, assertHeld = null }) {
  if (r2?.adapter?.headObject) {
    assertHeld?.();
    const result = await r2.adapter.headObject({ key });
    assertHeld?.();
    const sha256 = normalizeR2Sha256Checksum(
      result?.sha256 ?? result?.checksums?.sha256,
    );
    return sha256 ? { ...result, sha256 } : result;
  }
  const { response, errorText } = await fetchR2WithRetry({
    method: "HEAD",
    buildRequest: () => buildAwsSignedRequest({
      method: "HEAD",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: key,
      headers: {
        "x-amz-checksum-mode": "ENABLED",
        // R2 can weaken HEAD ETags during compression and omit Content-Length.
        // Use identity only when the caller requests byte-exact cache validation.
        ...(accept_encoding_identity ? { "accept-encoding": "identity" } : {}),
      },
    }),
    consumeResponse: async (response) => ({
      response,
      errorText: response.ok || response.status === 404
        ? ""
        : await readResponseText(response, 2000),
    }),
    assertHeld,
  });

  if (response.status === 404) {
    return {
      exists: false,
      key,
    };
  }

  if (!response.ok) {
    throw new Error(`R2 HEAD failed (${response.status}) key=${key}: ${errorText}`);
  }

  const bytesHeader = response.headers.get("content-length");
  return {
    exists: true,
    key,
    etag: response.headers.get("etag") || null,
    last_modified: response.headers.get("last-modified") || null,
    bytes: bytesHeader ? Number(bytesHeader) : null,
    sha256: normalizeR2Sha256Checksum(
      response.headers.get("x-amz-checksum-sha256"),
    ),
  };
}

// One-attempt bounded GET, including response-body consumption. Existing buffered
// callers are unchanged. Adapters must explicitly implement bounded acquisition;
// falling back to getObject would allocate an unbounded body before admission.
export async function r2GetObjectBounded({ r2, key, max_bytes, timeout_ms = R2_REQUEST_TIMEOUT_MS, signal,
  accept_encoding_identity = false }) {
  if (!Number.isSafeInteger(max_bytes) || max_bytes <= 0 ||
      !Number.isSafeInteger(timeout_ms) || timeout_ms <= 0 || timeout_ms > R2_REQUEST_TIMEOUT_MS) {
    throw new TypeError("Bounded R2 GET requires positive byte and timeout budgets");
  }
  const validate = (stored) => {
    if (!(stored?.body instanceof Uint8Array) || stored.body.byteLength > max_bytes ||
        stored.bytes !== stored.body.byteLength) {
      throw new Error("Bounded R2 GET body/size mismatch or byte budget exceeded");
    }
    return { ...stored, key, body: Buffer.from(stored.body) };
  };
  if (r2?.adapter) {
    if (typeof r2.adapter.getObjectBounded !== "function") {
      throw new TypeError("R2 adapter must implement getObjectBounded");
    }
    const controller = new AbortController();
    let timer;
    let rejectAbort;
    const abortFromCaller = () => {
      controller.abort(signal.reason);
      rejectAbort?.(signal.reason || new Error('Bounded R2 GET aborted'));
    };
    try {
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      if (signal?.aborted) throw signal.reason || new Error('Bounded R2 GET aborted');
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      return validate(await Promise.race([
        r2.adapter.getObjectBounded({ key, max_bytes, signal: controller.signal,
          ...(accept_encoding_identity ? { accept_encoding_identity: true } : {}) }),
        aborted,
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Bounded R2 GET deadline exceeded"));
        }, timeout_ms); }),
      ]));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abortFromCaller); }
  }
  const request = buildAwsSignedRequest({ method: "GET", endpoint: r2.endpoint,
    region: r2.region, accessKeyId: r2.access_key_id, secretAccessKey: r2.secret_access_key,
    bucket: r2.bucket, objectKey: key,
    // Opt in only for callers requiring the stored representation's validator.
    ...(accept_encoding_identity ? { headers: { "accept-encoding": "identity" } } : {}) });
  return await fetchWithTimeout(request.url, {
    method: "GET", headers: request.headers, redirect: "error", signal,
  }, timeout_ms, globalThis.fetch, async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Bounded R2 GET failed (${response.status}) key=${key}`);
      error.status = response.status;
      throw error;
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) ||
        !Number.isSafeInteger(Number(declared)) || Number(declared) > max_bytes)) {
      await response.body?.cancel();
      throw new Error("Bounded R2 GET content length exceeds byte budget");
    }
    if (!response.body) throw new Error("Bounded R2 GET response body missing");
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > max_bytes) throw new Error("Bounded R2 GET byte budget exceeded");
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    if (declared !== null && Number(declared) !== bytes) {
      throw new Error("Bounded R2 GET content length mismatch");
    }
    return validate({ body: Buffer.concat(chunks, bytes), bytes,
      etag: response.headers.get("etag") || null });
  });
}

export async function r2GetObject({
  r2,
  key,
  max_attempts = R2_REQUEST_MAX_ATTEMPTS,
  accept_encoding_identity = false,
}) {
  if (r2?.adapter?.getObject) {
    return r2.adapter.getObject({ key });
  }
  const { response, arrayBuffer, errorText } = await fetchR2WithRetry({
    method: "GET",
    buildRequest: () => buildAwsSignedRequest({
      method: "GET",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: key,
      // Cache-populating GETs must request the same representation as their HEAD.
      ...(accept_encoding_identity ? { headers: { "accept-encoding": "identity" } } : {}),
    }),
    consumeResponse: async (response) => ({
      response,
      arrayBuffer: response.ok ? await response.arrayBuffer() : null,
      errorText: response.ok ? "" : await readResponseText(response, 3000),
    }),
    maxAttempts: max_attempts,
  });

  if (!response.ok) {
    const error = new Error(`R2 GET failed (${response.status}) key=${key}: ${errorText}`);
    error.status = response.status;
    error.code = `HTTP_${response.status}`;
    throw error;
  }

  return {
    key,
    bytes: arrayBuffer.byteLength,
    body: Buffer.from(arrayBuffer),
    etag: response.headers.get("etag") || null,
  };
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseListObjectsXml(xml) {
  const entries = [];
  const commonPrefixes = [];
  const contentMatches = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  for (const match of contentMatches) {
    const block = match[1];
    const keyMatch = block.match(/<Key>([^<]+)<\/Key>/);
    if (!keyMatch) {
      continue;
    }
    const sizeMatch = block.match(/<Size>([^<]+)<\/Size>/);
    const etagMatch = block.match(/<ETag>([^<]+)<\/ETag>/);
    const modifiedMatch = block.match(/<LastModified>([^<]+)<\/LastModified>/);
    entries.push({
      key: decodeXmlEntities(keyMatch[1]),
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      etag: etagMatch ? decodeXmlEntities(etagMatch[1]).replace(/^"|"$/g, "") : null,
      last_modified: modifiedMatch ? decodeXmlEntities(modifiedMatch[1]) : null,
    });
  }

  const prefixMatches = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)];
  for (const match of prefixMatches) {
    const block = match[1];
    const prefixMatch = block.match(/<Prefix>([^<]+)<\/Prefix>/);
    if (!prefixMatch) {
      continue;
    }
    commonPrefixes.push(decodeXmlEntities(prefixMatch[1]));
  }

  const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
  return {
    entries,
    common_prefixes: commonPrefixes,
    next_token: tokenMatch ? decodeXmlEntities(tokenMatch[1]) : null,
  };
}

export async function r2ListObjectsV2({
  r2,
  prefix,
  continuation_token = null,
  max_keys = 1000,
  delimiter = null,
  require_valid_listing = false,
}) {
  const query = {
    "list-type": 2,
    "max-keys": String(max_keys),
    prefix,
  };
  if (continuation_token) {
    query["continuation-token"] = continuation_token;
  }
  if (delimiter) {
    query.delimiter = delimiter;
  }

  const { response, text: xml } = await fetchR2WithRetry({
    method: "GET",
    buildRequest: () => buildAwsSignedRequest({
      method: "GET",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: "",
      query,
    }),
    consumeResponse: async (response) => ({
      response,
      text: await response.text(),
    }),
  });

  if (!response.ok) {
    const text = xml.length <= 4000 ? xml : xml.slice(0, 4000);
    throw new Error(`R2 LIST failed (${response.status}) prefix=${prefix}: ${text}`);
  }

  const parsed = parseListObjectsXml(xml);
  if (require_valid_listing) {
    const truncated = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
    const returnedPrefix = xml.match(/<Prefix>([^<]*)<\/Prefix>/);
    const returnedBucket = xml.match(/<Name>([^<]+)<\/Name>/);
    const keyCount = xml.match(/<KeyCount>([0-9]+)<\/KeyCount>/);
    if (!/<ListBucketResult(?:\s[^>]*)?>/.test(xml) || !/<\/ListBucketResult>/.test(xml) || !truncated ||
        !returnedPrefix || decodeXmlEntities(returnedPrefix[1]) !== prefix ||
        !returnedBucket || decodeXmlEntities(returnedBucket[1]) !== r2.bucket ||
        !keyCount || Number(keyCount[1]) !== parsed.entries.length || parsed.common_prefixes.length ||
        (xml.match(/<IsTruncated>/g) || []).length !== 1 ||
        (xml.match(/<Contents>/g) || []).length !== parsed.entries.length ||
        (truncated[1] === 'true' && !parsed.next_token)) throw new Error(`Invalid R2 admission listing: ${prefix}`);
    return { ...parsed, is_truncated: truncated[1] === 'true' };
  }
  return parsed;
}

export async function r2ListAllObjects({ r2, prefix, max_keys = 1000 }) {
  if (r2?.adapter?.listAllObjects) {
    return r2.adapter.listAllObjects({ prefix, max_keys });
  }
  const entries = [];
  let token = null;
  for (;;) {
    const page = await r2ListObjectsV2({
      r2,
      prefix,
      continuation_token: token,
      max_keys,
    });
    entries.push(...page.entries);
    if (!page.next_token) {
      break;
    }
    token = page.next_token;
  }
  return entries;
}

export async function r2ListAllCommonPrefixes({ r2, prefix, delimiter = "/", max_keys = 1000 }) {
  if (r2?.adapter?.listAllCommonPrefixes) {
    return r2.adapter.listAllCommonPrefixes({ prefix, delimiter, max_keys });
  }
  const prefixes = [];
  let token = null;
  for (;;) {
    const page = await r2ListObjectsV2({
      r2,
      prefix,
      continuation_token: token,
      max_keys,
      delimiter,
    });
    prefixes.push(...(Array.isArray(page.common_prefixes) ? page.common_prefixes : []));
    if (!page.next_token) {
      break;
    }
    token = page.next_token;
  }
  return Array.from(new Set(prefixes)).sort((a, b) => a.localeCompare(b));
}

function buildDeleteObjectsXml(keys) {
  const escapedKeys = keys.map((key) => key
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Delete>",
    ...escapedKeys.map((key) => `  <Object><Key>${key}</Key></Object>`),
    "</Delete>",
  ].join("\n");
}

export async function r2DeleteObjects({ r2, keys }) {
  if (!Array.isArray(keys) || keys.length === 0) {
    return {
      deleted_count: 0,
      errors: [],
    };
  }

  const xmlBody = buildDeleteObjectsXml(keys);
  const bodyBuffer = Buffer.from(xmlBody, "utf8");
  const payloadHash = createHash("sha256").update(bodyBuffer).digest("hex");
  const contentMd5 = createHash("md5").update(bodyBuffer).digest("base64");

  const { response, text: xml } = await fetchR2WithRetry({
    method: "POST",
    body: bodyBuffer,
    buildRequest: () => buildAwsSignedRequest({
      method: "POST",
      endpoint: r2.endpoint,
      region: r2.region,
      accessKeyId: r2.access_key_id,
      secretAccessKey: r2.secret_access_key,
      bucket: r2.bucket,
      objectKey: "",
      query: { delete: "" },
      payloadHash,
      headers: {
        "content-type": "application/xml",
        "content-length": String(bodyBuffer.byteLength),
        "content-md5": contentMd5,
      },
    }),
    consumeResponse: async (response) => ({
      response,
      text: await response.text(),
    }),
  });

  if (!response.ok) {
    const text = xml.length <= 4000 ? xml : xml.slice(0, 4000);
    throw new Error(`R2 delete objects failed (${response.status}): ${text}`);
  }

  const deleted = [...xml.matchAll(/<Deleted>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Deleted>/g)]
    .map((match) => decodeXmlEntities(match[1]));
  const errors = [...xml.matchAll(/<Error>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Code>([^<]+)<\/Code>[\s\S]*?<Message>([^<]+)<\/Message>[\s\S]*?<\/Error>/g)]
    .map((match) => ({
      key: decodeXmlEntities(match[1]),
      code: decodeXmlEntities(match[2]),
      message: decodeXmlEntities(match[3]),
    }));

  return {
    deleted_count: deleted.length,
    deleted_keys: deleted,
    errors,
  };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
