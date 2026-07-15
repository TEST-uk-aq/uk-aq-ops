const CONTRACT_VERSION = "v1";
const INTERNAL_PREFIX = "/internal";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";

function headersFor(responseHeaders = undefined) {
  const headers = new Headers(responseHeaders);
  headers.set("X-UK-AQ-Station-History-Contract", CONTRACT_VERSION);
  headers.set("X-UK-AQ-Station-History-Worker", "uk-aq-station-history");
  return headers;
}

function errorResponse(status, code, route, detail = undefined) {
  return new Response(JSON.stringify({ ok: false, error: { code, route, ...(detail ? { detail } : {}) } }), {
    status,
    headers: headersFor({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function required(value) {
  return String(value ?? "").trim();
}

function copyForwardHeaders(request, targetHeaders) {
  for (const name of ["Accept", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) targetHeaders.set(name, value);
  }
}

async function proxy(request, target, headers) {
  try {
    const upstream = await fetch(target, { method: request.method, headers });
    const responseHeaders = headersFor(upstream.headers);
    responseHeaders.delete("Set-Cookie");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch {
    return errorResponse(502, "internal_upstream_fetch_failed", new URL(request.url).pathname);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = url.pathname;
    if (request.method !== "GET") return errorResponse(405, "internal_method_not_allowed", route);
    if (!route.startsWith(`${INTERNAL_PREFIX}/`)) return errorResponse(404, "internal_route_not_found", route);
    const upstreamSecret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
    if (!upstreamSecret) return errorResponse(500, "internal_upstream_secret_missing", route);

    if (route === "/internal/aqi-history") {
      const baseUrl = required(env.UK_AQ_AQI_HISTORY_R2_API_URL);
      if (!baseUrl) return errorResponse(500, "internal_aqi_history_url_missing", route);
      const target = new URL(baseUrl);
      target.search = url.search;
      const headers = new Headers({ Accept: request.headers.get("Accept") || "application/json", [UPSTREAM_AUTH_HEADER]: upstreamSecret });
      copyForwardHeaders(request, headers);
      return proxy(request, target.toString(), headers);
    }

    if (route === "/internal/timeseries") {
      const supabaseUrl = required(env.SUPABASE_URL);
      const publishableKey = required(env.SB_PUBLISHABLE_DEFAULT_KEY);
      if (!supabaseUrl || !publishableKey) return errorResponse(500, "internal_timeseries_config_missing", route);
      const target = new URL(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/uk_aq_timeseries`);
      target.search = url.search;
      const headers = new Headers({ Accept: request.headers.get("Accept") || "application/json", apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, [UPSTREAM_AUTH_HEADER]: upstreamSecret });
      copyForwardHeaders(request, headers);
      return proxy(request, target.toString(), headers);
    }

    if (route === "/internal/station-series") return errorResponse(501, "station_series_not_implemented", route);
    return errorResponse(404, "internal_route_not_found", route);
  },
};

export { CONTRACT_VERSION, errorResponse };
