import { addCorsHeaders, isOriginAllowed, parseAllowedOrigins, readSecret, resolveRequestOrigin } from "./index.ts";

export const BC_UV_DIURNAL_API_PATH = "/api/aq/bc-uv/diurnal";
export type BcUvDiurnalEnv = {
  UK_AQ_CACHE_ALLOWED_ORIGINS?: unknown;
  UK_AQ_OBSERVS_HISTORY_R2_API_URL?: unknown;
  UK_AQ_EDGE_UPSTREAM_SECRET?: unknown;
};

function failure(status: number, code: string, origin: string | null, allowed: Set<string>): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  addCorsHeaders(headers, origin, allowed);
  return new Response(JSON.stringify({ ok: false, error: code }), { status, headers });
}

export async function handleBcUvDiurnalProxyRequest(request: Request, env: BcUvDiurnalEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = resolveRequestOrigin(request, url);
  const allowed = parseAllowedOrigins(await readSecret(env.UK_AQ_CACHE_ALLOWED_ORIGINS));
  if (!allowed.size) return failure(500, "missing_allowed_origins", origin, allowed);
  if (!origin || !isOriginAllowed(origin, allowed)) return failure(origin ? 403 : 400, origin ? "origin_not_allowed" : "origin_required", origin, allowed);
  if (request.method === "OPTIONS") {
    const headers = new Headers({ Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" });
    addCorsHeaders(headers, origin, allowed);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return failure(405, "method_not_allowed", origin, allowed);
  if (url.search) return failure(400, "unexpected_query", origin, allowed);
  const configured = String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || "").trim();
  const secret = await readSecret(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!configured || !secret) return failure(500, "missing_bc_uv_upstream", origin, allowed);
  let upstream: URL;
  try {
    upstream = new URL(configured);
    if (upstream.protocol !== "https:") throw new Error("HTTPS required");
    upstream.pathname = "/v1/bc-uv/diurnal";
    upstream.search = "";
  } catch { return failure(500, "invalid_bc_uv_upstream", origin, allowed); }
  let response: Response;
  try {
    response = await fetch(upstream.toString(), { method: request.method, headers: {
      Accept: "application/json", "X-UK-AQ-Upstream-Auth": secret,
    } });
  } catch { return failure(502, "bc_uv_upstream_failed", origin, allowed); }
  const headers = new Headers(response.headers);
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");
  headers.set("Cache-Control", response.ok ? "public, max-age=3600" : "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  addCorsHeaders(headers, origin, allowed);
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}
