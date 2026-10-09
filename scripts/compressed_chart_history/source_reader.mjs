import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildAwsSignedRequest } from "../../workers/shared/r2_sigv4.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// This pilot deliberately admits only AURN and the named TEST bucket. No LIST,
// PUT, DELETE, database access, credential output or runtime-selector changes.
export function createSourceReader(generation, { maxBytes = 512 * 1024 ** 2 } = {}) {
  requireCondition(["v2", "v3"].includes(generation), "Select v2 or v3 explicitly");
  requireCondition(process.env.UK_AQ_ENV_NAME === "TEST", "UK_AQ_ENV_NAME must be TEST");
  requireCondition(process.env.CFLARE_R2_BUCKET === "uk-aq-history-cic-test", "Unexpected TEST bucket");
  const endpoint = process.env.CFLARE_R2_ENDPOINT;
  requireCondition(endpoint && new URL(endpoint).protocol === "https:", "HTTPS R2 endpoint required");
  const r2 = {
    endpoint, bucket: process.env.CFLARE_R2_BUCKET,
    region: process.env.CFLARE_R2_REGION || "auto",
    accessKeyId: process.env.CFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CFLARE_R2_SECRET_ACCESS_KEY,
  };
  requireCondition(r2.accessKeyId && r2.secretAccessKey, "Existing R2 credentials required");
  const cache = new Map();
  const inventory = new Map();
  const metrics = {
    get_requests: 0, not_found_requests: 0, source_bytes_read: 0,
    parquet_bytes_read: 0, metadata_bytes_read: 0, read_wall_ms: 0,
    stability_check_requests: 0,
  };
  function admit(key) {
    requireCondition(typeof key === "string" && !key.split("/").some((v) => !v || v === "." || v === ".."), "Invalid source key");
    const observation = new RegExp(`^history/${generation}/observations/(?:_manifests/manifest\\.json|day_utc=\\d{4}-\\d{2}-\\d{2}/(?:manifest\\.json|connector_id=1/(?:manifest\\.json|pollutant_code=[a-z0-9_]+/[^/]+)))$`);
    const index = new RegExp(`^history/_index_${generation}/(?:timeseries_binding/timeseries_id=\\d+\\.json|observations_timeseries/day_utc=\\d{4}-\\d{2}-\\d{2}/connector_id=1/(?:manifest\\.json|pollutant_code=[a-z0-9_]+/[^/]+))$`);
    const verification = generation === "v3" && (
      key === "history/_index_v3/verification/latest.json" ||
      /^history\/v3\/verification\/connector_id=1\/manifests\/[0-9a-f]{64}\.json$/.test(key)
    );
    requireCondition(observation.test(key) || index.test(key) || verification, "Source key outside admitted TEST AURN roots");
  }
  async function read(key, { fresh = false, expected = null } = {}) {
    admit(key);
    if (!fresh && cache.has(key)) {
      const result = cache.get(key);
      verify(result, expected, key);
      return result;
    }
    const started = performance.now();
    requireCondition(metrics.get_requests < 2048, "Source GET request budget exceeded");
    metrics.get_requests++;
    if (fresh) metrics.stability_check_requests++;
    let response;
    try {
      const request = buildAwsSignedRequest({ method: "GET", ...r2, objectKey: key });
      response = await fetch(request.url, { method: "GET", headers: request.headers, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`Source GET transport failure: ${key}`);
    }
    if (response.status === 404) {
      metrics.not_found_requests++;
      await response.body?.cancel();
      metrics.read_wall_ms += performance.now() - started;
      if (!fresh) cache.set(key, null);
      requireCondition(!expected, `Referenced source missing: ${key}`);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Source GET HTTP ${response.status}: ${key}`);
    }
    const objectCap = key.endsWith(".parquet") ? 64 * 1024 ** 2 : 16 * 1024 ** 2;
    const declared = Number(response.headers.get("content-length"));
    if (declared > objectCap || metrics.source_bytes_read + declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Read budget exceeded: ${key}`);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        metrics.source_bytes_read += chunk.length;
        metrics[key.endsWith(".parquet") ? "parquet_bytes_read" : "metadata_bytes_read"] += chunk.length;
        requireCondition(size <= objectCap && metrics.source_bytes_read <= maxBytes, "Streaming read budget exceeded");
        chunks.push(chunk);
      }
    } catch {
      throw new Error(`Source body failure or read budget exceeded: ${key}`);
    } finally {
      metrics.read_wall_ms += performance.now() - started;
    }
    const body = Buffer.concat(chunks);
    const result = { key, body, byte_size: size, sha256: sha256(body), etag: response.headers.get("etag") };
    verify(result, expected, key);
    if (!fresh) {
      cache.set(key, result);
      const { body: _body, ...identity } = result;
      inventory.set(key, identity);
    }
    return result;
  }
  function verify(result, expected, key) {
    if (!expected) return;
    requireCondition(result, `Referenced source missing: ${key}`);
    if (expected.byte_size !== undefined) requireCondition(result.byte_size === Number(expected.byte_size), `Source size mismatch: ${key}`);
    if (expected.sha256) requireCondition(result.sha256 === expected.sha256, `Source digest mismatch: ${key}`);
    if (expected.etag) requireCondition(result.etag?.replace(/^"|"$/g, "") === expected.etag.replace(/^"|"$/g, ""), `Source ETag mismatch: ${key}`);
  }
  async function json(key, options) {
    const result = await read(key, options);
    if (!result) return null;
    try { return JSON.parse(result.body); } catch { throw new Error(`Invalid source JSON: ${key}`); }
  }
  async function checkStability() {
    // No mutation lock: re-read all metadata, including previously absent keys.
    // This is a detected-change guard, not a claim of an atomic cloud snapshot.
    for (const [key, before] of cache) {
      if (key.endsWith(".parquet")) continue;
      const after = await read(key, { fresh: true });
      requireCondition((before?.sha256 ?? null) === (after?.sha256 ?? null), `Source authority changed during export: ${key}`);
    }
  }
  return { read, json, checkStability, inventory, metrics, generation, bucket: r2.bucket };
}
