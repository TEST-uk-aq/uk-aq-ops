export const WHO_SUMMARY_API_PATH = "/api/aq/who-summary";

const WHO_SUMMARY_UPSTREAM_PATH = "/v1/who-summary";
const CACHE_CONTRACT_VERSION = "2";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_FRESHNESS = new Set(["current", "behind", "ahead"]);
const BROWSER_CACHE_CONTROL = "no-store";
const CURRENT_TTL_SECONDS = 86_400;
const BEHIND_TTL_SECONDS = 1_800;
const STALE_IF_ERROR_SECONDS = 86_400;

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

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

function canonicalCacheRequest(request: Request, requestedAsOfDayUtc: string): Request {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = WHO_SUMMARY_API_PATH;
  cacheUrl.search = "";
  cacheUrl.searchParams.set("as_of", requestedAsOfDayUtc);
  cacheUrl.searchParams.set("__uk_aq_who_contract", CACHE_CONTRACT_VERSION);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function responseForMethod(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function browserResponse(response: Response, cacheStatus: "HIT" | "MISS"): Response {
  const headers = new Headers(response.headers);
  const workerCacheControl = String(headers.get("Cache-Control") || "").trim();
  if (workerCacheControl) {
    headers.set("X-UK-AQ-WHO-Worker-Cache-Control", workerCacheControl);
  }
  headers.set("Cache-Control", BROWSER_CACHE_CONTROL);
  headers.set("X-UK-AQ-Cache", cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

function internalCacheControlFor(freshness: string): string {
  const ttl = freshness === "behind" ? BEHIND_TTL_SECONDS : CURRENT_TTL_SECONDS;
  return `public, max-age=${ttl}, s-maxage=${ttl}, stale-if-error=${STALE_IF_ERROR_SECONDS}`;
}

function isCacheableWhoResponse(response: Response): boolean {
  if (!response.ok) return false;
  const freshness = String(response.headers.get("X-UK-AQ-WHO-Freshness") || "").trim();
  const requestedAsOf = String(response.headers.get("X-UK-AQ-WHO-Requested-As-Of") || "").trim();
  const dataAsOf = String(response.headers.get("X-UK-AQ-WHO-Data-As-Of") || "").trim();
  const cacheControl = String(response.headers.get("Cache-Control") || "").toLowerCase();
  return VALID_FRESHNESS.has(freshness)
    && isValidUtcDay(requestedAsOf)
    && isValidUtcDay(dataAsOf)
    && !cacheControl.includes("no-store")
    && /(?:^|,)\s*(?:s-maxage|max-age)=\d+/.test(cacheControl);
}

export async function handleWhoSummaryProxyRequest(
  request: Request,
  env: WhoSummaryProxyEnv,
  ctx: ExecutionContextLike,
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
    return jsonError(400, "invalid_as_of", "as_of must be a valid UTC day in YYYY-MM-DD format");
  }

  const cacheRequest = canonicalCacheRequest(request, requestedAsOfDayUtc);
  const cached = await (caches as CacheStorage & { default: Cache }).default.match(cacheRequest);
  if (cached) {
    return responseForMethod(request, browserResponse(cached, "HIT"));
  }

  const targetUrl = upstreamUrl(env, requestedAsOfDayUtc);
  const upstreamSecret = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!targetUrl || !upstreamSecret) {
    return jsonError(500, "missing_who_upstream", "WHO summary R2 upstream is not configured");
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        [UPSTREAM_AUTH_HEADER]: upstreamSecret,
      },
    });
  } catch (error) {
    console.error("WHO summary upstream request failed", error);
    return jsonError(502, "who_upstream_failed", "WHO summary upstream request failed");
  }

  const cacheHeaders = new Headers(upstreamResponse.headers);
  const freshness = String(cacheHeaders.get("X-UK-AQ-WHO-Freshness") || "").trim();
  if (VALID_FRESHNESS.has(freshness)) {
    cacheHeaders.set("Cache-Control", internalCacheControlFor(freshness));
  }
  const cacheResponse = new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: cacheHeaders,
  });

  if (isCacheableWhoResponse(cacheResponse)) {
    ctx.waitUntil(
      (caches as CacheStorage & { default: Cache }).default
        .put(cacheRequest, cacheResponse.clone())
        .catch((error) => console.warn("WHO summary cache-proxy cache write failed", error)),
    );
  }

  return responseForMethod(request, browserResponse(cacheResponse, "MISS"));
}
