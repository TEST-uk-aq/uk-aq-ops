import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { buildAwsSignedRequest } from "../../workers/shared/r2_sigv4.mjs";
import { validatePilotConfig, COMPRESSED_CHART_LIMITS } from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// Read-only, finite selection. Environment/resource identity is operator config.
export function createSourceReader(generation, { config, sample, contextStart, end, maxBytes = COMPRESSED_CHART_LIMITS.source_bytes } = {}) {
  validatePilotConfig(config, process.env.UK_AQ_ENV_NAME);
  requireCondition(generation === config.canonical_generation, "Selected generation mismatch");
  requireCondition(config.samples.some(entry => entry.id === sample?.id), "Configured sample required");
  requireCondition(process.env.CFLARE_R2_BUCKET === config.source_bucket, "Configured canonical bucket mismatch");
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= COMPRESSED_CHART_LIMITS.source_bytes, "Source byte bound");
  const deadline = performance.now() + COMPRESSED_CHART_LIMITS.duration_ms;
  const checkBudget = () => requireCondition(performance.now() < deadline, "Source processing time budget exceeded");
  const endpoint = process.env.CFLARE_R2_ENDPOINT;
  requireCondition(endpoint && new URL(endpoint).origin === config.source_endpoint
    && [config.source_endpoint, `${config.source_endpoint}/`].includes(endpoint), "Configured canonical endpoint mismatch");
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
    const connector = sample.connector_id, pollutant = sample.pollutant_code;
    const observation = new RegExp(`^history/${generation}/observations/(?:_manifests/manifest\\.json|day_utc=\\d{4}-\\d{2}-\\d{2}/(?:manifest\\.json|connector_id=${connector}/(?:manifest\\.json|pollutant_code=${pollutant}/[^/]+)))$`);
    const index = new RegExp(`^history/_index_${generation}/observations_timeseries/day_utc=\\d{4}-\\d{2}-\\d{2}/connector_id=${connector}/(?:manifest\\.json|pollutant_code=${pollutant}/[^/]+)$`);
    const binding = /^history\/_index_v3\/timeseries_binding\/timeseries_id=(\d+)\.json$/.exec(key);
    const verification = key === "history/_index_v3/verification/latest.json"
      || new RegExp(`^history/v3/verification/connector_id=${connector}/manifests/[0-9a-f]{64}\\.json$`).test(key);
    requireCondition(observation.test(key) || index.test(key) || verification
      || (binding && sample.permitted_timeseries_ids.includes(Number(binding[1]))), "Source key outside configured scope");
    const day = /\/day_utc=(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1];
    if (day) requireCondition(day >= contextStart.slice(0, 10) && day <= new Date(Date.parse(end) - 1).toISOString().slice(0, 10), "Source day outside bounded interval");
  }
  async function read(key, { fresh = false, expected = null } = {}) {
    checkBudget();
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
      response = await fetch(request.url, { method: "GET", headers: request.headers, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.floor(deadline - performance.now())))) });
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
        checkBudget();
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
  return { read, json, checkStability, inventory, metrics, generation, checkBudget, bucket: r2.bucket };
}
