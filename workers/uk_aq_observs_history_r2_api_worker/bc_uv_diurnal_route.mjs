export const BC_UV_DIURNAL_UPSTREAM_PATH = "/v1/bc-uv/diurnal";
const LATEST_KEY = "derived/bc_uv_diurnal/v1/latest.json";
const AUTH_HEADER = "x-uk-aq-upstream-auth";

function error(status, code) {
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}

function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function valid(body) {
  try {
    const value = JSON.parse(body);
    return value.contract_version === 1 && value.network_code === "black_carbon" &&
      Array.isArray(value.properties) && value.properties.join(",") === "bc,uv370,uvpm" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.source_through_day) &&
      !Number.isNaN(Date.parse(value.generated_at)) &&
      Array.isArray(value.months) && value.months.length > 0 &&
      Array.isArray(value.sensors) && value.sensors.length > 0 &&
      value.sensors.every((sensor) => sensor.network_code === "black_carbon" &&
        Number.isInteger(sensor.station_id) && sensor.station_ref && sensor.name &&
        Number.isFinite(sensor.latitude) && Number.isFinite(sensor.longitude) &&
        ["bc", "uv370", "uvpm"].every((property) => Array.isArray(sensor.profiles?.[property]) &&
          sensor.profiles[property].length === value.months.length &&
          sensor.profiles[property].every((profile) => Array.isArray(profile.points) && profile.points.length === 24)));
  } catch { return false; }
}

export async function handleBcUvDiurnalUpstreamRequest(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method_not_allowed");
  const secret = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!secret) return error(500, "missing_upstream_secret");
  if (!equal(String(request.headers.get(AUTH_HEADER) || "").trim(), secret)) return error(401, "unauthorised");
  if (!env.UK_AQ_HISTORY_BUCKET) return error(500, "missing_r2_binding");
  if (new URL(request.url).search) return error(400, "unexpected_query");
  const cacheKey = new Request(new URL(BC_UV_DIURNAL_UPSTREAM_PATH, request.url).toString());
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) {
    const text = await cached.text();
    if (valid(text)) return new Response(request.method === "HEAD" ? null : text, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  }
  let object;
  try { object = await env.UK_AQ_HISTORY_BUCKET.get(LATEST_KEY); }
  catch { return error(502, "r2_read_failed"); }
  if (!object) return error(404, "bc_uv_diurnal_not_published");
  let body;
  try { body = await object.text(); }
  catch { return error(502, "r2_body_failed"); }
  if (!valid(body)) return error(502, "invalid_bc_uv_diurnal_product");
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff" });
  if (object.httpEtag || object.etag) headers.set("ETag", object.httpEtag || `"${object.etag}"`);
  if (cache) ctx?.waitUntil?.(cache.put(cacheKey, new Response(body, { headers })));
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
