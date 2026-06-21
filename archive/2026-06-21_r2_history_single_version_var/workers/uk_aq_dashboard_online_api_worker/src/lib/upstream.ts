import { errorEnvelope, withCorsAndCacheControl, withCorsAndNoStore } from "./http";

export type WorkerEnv = {
  DASHBOARD_UPSTREAM_BASE_URL?: string;
  DASHBOARD_UPSTREAM_BEARER_TOKEN?: string;
  UKAQ_PROXY_ROUTE_PREFIX?: string;
  SUPABASE_URL?: string;
  SB_SECRET_KEY?: string;
  OBS_AQIDB_SUPABASE_URL?: string;
  OBS_AQIDB_SECRET_KEY?: string;
  UK_AQ_CORE_SCHEMA?: string;
  UK_AQ_PUBLIC_SCHEMA?: string;
  UK_AQ_OPS_SCHEMA?: string;
  UK_AQ_DB_SIZE_API_URL?: string;
  UK_AQ_DB_SIZE_API_TOKEN?: string;
  UK_AQ_DB_SIZE_LOOKBACK_DAYS?: string;
  UK_AQ_R2_HISTORY_DAYS_API_URL?: string;
  UK_AQ_R2_HISTORY_DAYS_API_TOKEN?: string;
  UK_AQ_R2_HISTORY_DAYS_API_MAX_DAYS?: string;
  UK_AQ_R2_HISTORY_COUNTS_API_URL?: string;
  UK_AQ_R2_HISTORY_COUNTS_API_TOKEN?: string;
  UK_AQ_R2_HISTORY_READ_VERSION?: string;
  UK_AQ_OBSERVS_HISTORY_R2_API_URL?: string;
  UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN?: string;
  UK_AQ_AQI_HISTORY_R2_API_URL?: string;
  UK_AQ_AQI_HISTORY_R2_API_TOKEN?: string;
  UK_AQ_R2_HISTORY_WINDOW_RPC?: string;
  UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID?: string;
  UK_AQ_R2_CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CFLARE_API_READ_TOKEN?: string;
  DROPBOX_APP_KEY?: string;
  DROPBOX_APP_SECRET?: string;
  DROPBOX_REFRESH_TOKEN?: string;
  UK_AQ_DROPBOX_ROOT?: string;
  UK_AQ_R2_HISTORY_DROPBOX_DIR?: string;
  UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH?: string;
  CLEANAIRSURB_ST_ID?: string;
};

export type ProxyCacheOptions = {
  cacheTtlSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  bypassCache?: boolean;
  ignoredCacheSearchParams?: string[];
};

export class UpstreamError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function defaultEdgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function resolveBaseUrl(env: WorkerEnv): string {
  const base = String(env.DASHBOARD_UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new UpstreamError(
      "UPSTREAM_NOT_CONFIGURED",
      "DASHBOARD_UPSTREAM_BASE_URL is required for API proxy routes",
      500,
    );
  }
  return base;
}

export function shouldUseUpstream(request: Request, env: WorkerEnv): boolean {
  const base = String(env.DASHBOARD_UPSTREAM_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base) {
    return false;
  }
  try {
    const upstreamHost = new URL(base).host.toLowerCase();
    const requestHost = new URL(request.url).host.toLowerCase();
    // Guard against self-proxy loops when the upstream URL points at the same route hostname.
    if (upstreamHost === requestHost) {
      return false;
    }
    return true;
  } catch (_err) {
    return false;
  }
}

function normalizePath(pathname: string): string {
  if (!pathname.startsWith("/")) {
    return `/${pathname}`;
  }
  return pathname;
}

export function buildUpstreamUrl(env: WorkerEnv, pathname: string, search = ""): string {
  const base = resolveBaseUrl(env);
  const path = normalizePath(pathname);
  return `${base}${path}${search || ""}`;
}

export async function proxyToUpstream(
  request: Request,
  env: WorkerEnv,
  upstreamPathname: string,
  cacheOptions?: ProxyCacheOptions,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamUrl(env, upstreamPathname, incomingUrl.search);
  const method = request.method.toUpperCase();
  const headers = new Headers();
  const incomingContentType = request.headers.get("content-type");
  if (incomingContentType) {
    headers.set("content-type", incomingContentType);
  }

  const token = String(env.DASHBOARD_UPSTREAM_BEARER_TOKEN || "").trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const cacheTtlSeconds = Math.max(0, Number(cacheOptions?.cacheTtlSeconds || 0));
  const staleWhileRevalidateSeconds = Math.max(
    0,
    Number(cacheOptions?.staleWhileRevalidateSeconds || 0),
  );
  const useEdgeCache = method === "GET" && cacheTtlSeconds > 0;
  const bypassCache = Boolean(cacheOptions?.bypassCache);
  const cacheControl = useEdgeCache && !bypassCache
    ? `public, max-age=${cacheTtlSeconds}, s-maxage=${cacheTtlSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`
    : "no-store";
  const cacheKeyUrl = new URL(incomingUrl.toString());
  for (const key of cacheOptions?.ignoredCacheSearchParams || []) {
    cacheKeyUrl.searchParams.delete(key);
  }
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

  if (useEdgeCache && !bypassCache) {
    const cached = await defaultEdgeCache().match(cacheKey);
    if (cached) {
      const hit = withCorsAndCacheControl(cached, cacheControl);
      hit.headers.set("X-UKAQ-Worker-Cache", "HIT");
      return hit;
    }
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method,
      headers,
      body,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return errorEnvelope("UPSTREAM_UNREACHABLE", `Failed to reach upstream API: ${detail}`, 502);
  }

  if (!useEdgeCache) {
    return withCorsAndNoStore(upstreamResp);
  }

  const missResponse = withCorsAndCacheControl(upstreamResp, cacheControl);
  missResponse.headers.set("X-UKAQ-Worker-Cache", bypassCache ? "BYPASS" : "MISS");

  if (!bypassCache && upstreamResp.ok) {
    await defaultEdgeCache().put(cacheKey, missResponse.clone());
  }
  return missResponse;
}

export async function fetchUpstreamJson(
  env: WorkerEnv,
  pathname: string,
  searchParams?: URLSearchParams,
): Promise<unknown> {
  const query = searchParams && searchParams.toString() ? `?${searchParams.toString()}` : "";
  const targetUrl = buildUpstreamUrl(env, pathname, query);
  const headers = new Headers();

  const token = String(env.DASHBOARD_UPSTREAM_BEARER_TOKEN || "").trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }

  let resp: Response;
  try {
    resp = await fetch(targetUrl, {
      method: "GET",
      headers,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UpstreamError("UPSTREAM_UNREACHABLE", `Failed to reach upstream API: ${detail}`, 502);
  }

  const text = await resp.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_err) {
    parsed = null;
  }

  if (!resp.ok) {
    const message =
      parsed && typeof parsed === "object" && parsed !== null
        ? String((parsed as { error?: string; message?: string }).error || (parsed as { message?: string }).message || text || "Request failed")
        : text || `Upstream request failed (${resp.status})`;
    throw new UpstreamError("UPSTREAM_HTTP_ERROR", message, 502);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UpstreamError("UPSTREAM_INVALID_JSON", "Upstream JSON payload is missing or invalid", 502);
  }

  return parsed;
}
