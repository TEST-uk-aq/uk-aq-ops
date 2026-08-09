export const WHO_SUMMARY_API_PATH = "/api/aq/who-summary";

const WHO_SUMMARY_UPSTREAM_PATH = "/v1/who-summary";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BROWSER_CACHE_CONTROL = "no-store";

export type WhoSummaryProxyEnv = {
  UK_AQ_OBSERVS_HISTORY_R2_API_URL?: unknown;
  UK_AQ_EDGE_UPSTREAM_SECRET?: unknown;
};

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": BROWSER_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isValidUtcDay(value: string): boolean {
  if (!ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function upstreamUrl(env: WhoSummaryProxyEnv, requestedAsOfDayUtc: string): URL | null {
  const configured = String(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL || "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    url.pathname = WHO_SUMMARY_UPSTREAM_PATH;
    url.search = "";
    url.searchParams.set("as_of", requestedAsOfDayUtc);
    return url;
  } catch (_error) {
    return null;
  }
}

function publicResponse(request: Request, upstreamResponse: Response): Response {
  const headers = new Headers(upstreamResponse.headers);
  headers.set("Cache-Control", BROWSER_CACHE_CONTROL);
  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function responseForMethod(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function handleWhoSummaryProxyRequest(
  request: Request,
  env: WhoSummaryProxyEnv,
  _ctx: unknown,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        Allow: "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Accept",
        "Cache-Control": BROWSER_CACHE_CONTROL,
      },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS", "Cache-Control": BROWSER_CACHE_CONTROL },
    });
  }

  const requestUrl = new URL(request.url);
  const requestedAsOfDayUtc = String(requestUrl.searchParams.get("as_of") || "").trim();
  if (!isValidUtcDay(requestedAsOfDayUtc)) {
    return responseForMethod(
      request,
      jsonError(400, "invalid_as_of", "as_of must be a valid UTC day in YYYY-MM-DD format"),
    );
  }

  const targetUrl = upstreamUrl(env, requestedAsOfDayUtc);
  const upstreamSecret = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!targetUrl || !upstreamSecret) {
    return responseForMethod(
      request,
      jsonError(500, "missing_who_upstream", "WHO summary R2 upstream is not configured"),
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: {
        Accept: "application/json",
        [UPSTREAM_AUTH_HEADER]: upstreamSecret,
      },
    });
  } catch (error) {
    console.error("WHO summary upstream request failed", error);
    return responseForMethod(
      request,
      jsonError(502, "who_upstream_failed", "WHO summary upstream request failed"),
    );
  }

  return publicResponse(request, upstreamResponse);
}
