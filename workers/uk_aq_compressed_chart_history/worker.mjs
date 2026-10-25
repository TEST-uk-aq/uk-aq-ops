// Private opt-in experiment; payloads are pre-encoded and calculated offline.
import { canonicalText, validatePilotConfig, publicPilotCatalog, selectorKey, validateCompressedChartSelector,
  validateCompressedChartPublication, COMPRESSED_CHART_LIMITS as LIMITS } from "../shared/uk_aq_compressed_chart_pilot.mjs";
const AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const secretValue = value => typeof value?.get === "function" ? value.get() : value;
let cachedConfig = null;
function equalSecret(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function configuration(env) {
  const raw = await secretValue(env.UK_AQ_COMPRESSED_CHART_CONFIG);
  if (typeof raw !== "string" || raw.length > LIMITS.metadata_bytes) throw new Error("pilot_config_missing_or_oversize");
  if (cachedConfig?.raw === raw && cachedConfig.environment === env.UK_AQ_ENV_NAME) return cachedConfig;
  const config = validatePilotConfig(JSON.parse(raw), env.UK_AQ_ENV_NAME);
  cachedConfig = { raw, environment: env.UK_AQ_ENV_NAME, config,
    configSha: await sha256(new TextEncoder().encode(canonicalText(config))) };
  return cachedConfig;
}
async function readJson(bucket, key, maxBytes, expected = null) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size < 1 || object.size > maxBytes || (expected?.byte_size != null && object.size !== expected.byte_size)) { await object.body?.cancel(); return null; }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size || (expected?.sha256 && await sha256(bytes) !== expected.sha256)) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}
function exactQuery(url, names) {
  const keys = [...url.searchParams.keys()];
  return keys.length === names.length && names.every(name => keys.filter(key => key === name).length === 1);
}
function publicPublication(publication, digest) {
  const descriptor = ({ key: _key, ...publicFields }) => publicFields;
  return { ...publication, evidence: descriptor(publication.evidence), publication_sha256: digest,
    aqi_source: "precomputed_compressed_json", pairs: publication.pairs.map(pair => ({ ...pair,
      observations: descriptor(pair.observations), aqi: descriptor(pair.aqi) })) };
}
export default {
  async fetch(request, env) {
    const idHeader = request.headers.get("X-UK-AQ-Prototype-Request-ID") || "";
    const requestId = /^[a-zA-Z0-9-]{1,64}$/.test(idHeader) ? idHeader : crypto.randomUUID();
    const headers = { ...JSON_HEADERS, "X-UK-AQ-Prototype-Request-ID": requestId,
      "X-UK-AQ-Prototype-Environment": /^[A-Z][A-Z0-9_]{0,31}$/.test(String(env.UK_AQ_ENV_NAME || "")) ? String(env.UK_AQ_ENV_NAME) : "" };
    const error = (status, code) => Response.json({ error: { code } }, { status, headers });
    if (String(env.UK_AQ_COMPRESSED_CHART_ENABLED) !== "true" || !env.UK_AQ_COMPRESSED_CHART_BUCKET) return error(503, "pilot_disabled_or_unconfigured");
    if (!equalSecret(request.headers.get(AUTH_HEADER) || "", String(await secretValue(env.UK_AQ_EDGE_UPSTREAM_SECRET) || ""))) return error(403, "forbidden");
    if (request.method !== "GET") return error(405, "method_not_allowed");
    const url = new URL(request.url), route = url.pathname;
    if (!["/v1/manifest", "/v1/month", "/v1/aqi"].includes(route)) return error(404, "route_not_found");
    let configured;
    try { configured = await configuration(env); } catch { return error(503, "pilot_config_invalid"); }
    const { config, configSha } = configured, bucket = env.UK_AQ_COMPRESSED_CHART_BUCKET;
    try {
      const selector = await readJson(bucket, selectorKey(config), 16 * 1024);
      if (selector && !validateCompressedChartSelector(selector, config, configSha)) return error(502, "pilot_selection_invalid");
      if (route === "/v1/manifest" && exactQuery(url, [])) {
        console.log(JSON.stringify({ event: "compressed_chart_pilot_request", request_id: requestId, route, r2_reads: 1 }));
        return Response.json(publicPilotCatalog(config, configSha, selector?.samples || {}), { headers: { ...headers,
          "X-UK-AQ-Prototype-R2-Reads": "1", "X-UK-AQ-Prototype-Config": configSha } });
      }
      const sampleId = url.searchParams.get("sample"), sample = config.samples.find(entry => entry.id === sampleId);
      if (!sample) return error(400, "pilot_sample_invalid");
      if (!exactQuery(url, route === "/v1/manifest" ? ["sample"] : ["sample", "publication", "month_utc"])) return error(400, "pilot_query_invalid");
      const entry = selector?.samples[sampleId];
      if (!entry) return error(404, "pilot_publication_unavailable");
      const publication = await readJson(bucket, entry.manifest_key, LIMITS.metadata_bytes, { sha256: entry.manifest_sha256 });
      if (!publication || !validateCompressedChartPublication(publication, sampleId, config, configSha)) return error(502, "pilot_publication_invalid");
      const commonHeaders = { ...headers, "X-UK-AQ-Prototype-Publication": entry.manifest_sha256,
        "X-UK-AQ-Prototype-Config": configSha, "X-UK-AQ-Prototype-AQI-Source": "precomputed_compressed_json", "X-UK-AQ-Prototype-Cache": "BYPASS" };
      if (route === "/v1/manifest") {
        console.log(JSON.stringify({ event: "compressed_chart_pilot_request", request_id: requestId, route, sample_id: sampleId,
          publication_sha256: entry.manifest_sha256, r2_reads: 2 }));
        return Response.json(publicPublication(publication, entry.manifest_sha256), { headers: { ...commonHeaders, "X-UK-AQ-Prototype-R2-Reads": "2" } });
      }
      if (url.searchParams.get("publication") !== entry.manifest_sha256) return error(409, "pilot_publication_changed");
      const pair = publication.pairs.find(item => item.month_utc === url.searchParams.get("month_utc"));
      if (!pair) return error(400, "pilot_month_invalid");
      const part = route === "/v1/aqi" ? "aqi" : "observations", descriptor = pair[part];
      const counterpart = pair[part === "aqi" ? "observations" : "aqi"];
      const [object, other] = await Promise.all([bucket.get(descriptor.key), bucket.head(counterpart.key)]);
      if (!object || object.size !== descriptor.byte_size || !other || other.size !== counterpart.byte_size) {
        await object?.body?.cancel(); return error(502, "pilot_pair_unavailable");
      }
      console.log(JSON.stringify({ event: "compressed_chart_pilot_request", request_id: requestId, route, sample_id: sampleId,
        month_utc: pair.month_utc, publication_sha256: entry.manifest_sha256, r2_reads: 4, aqi_source: "precomputed_compressed_json" }));
      return new Response(object.body, { encodeBody: "manual", headers: { ...commonHeaders,
        "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(object.size),
        "X-UK-AQ-Prototype-Object-SHA256": descriptor.sha256, "X-UK-AQ-Prototype-Compressed-Bytes": String(object.size),
        "X-UK-AQ-Prototype-R2-Reads": "4" } });
    } catch {
      console.log(JSON.stringify({ event: "compressed_chart_pilot_error", request_id: requestId, route }));
      return error(502, "pilot_storage_unavailable");
    }
  },
};
