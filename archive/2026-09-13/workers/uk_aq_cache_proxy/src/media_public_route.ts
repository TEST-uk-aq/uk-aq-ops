export const MEDIA_PUBLIC_API_PATH = "/api/media/articles";

const MEDIA_PUBLIC_UPSTREAM_PATH = "/articles";
const MEDIA_PUBLIC_TIMEOUT_MS = 10_000;
const ALLOWED_QUERY_PARAMETERS = new Set(["limit", "before"]);
const RELAYED_RESPONSE_HEADERS = ["Content-Type", "Cache-Control", "ETag", "Last-Modified"];

export type MediaPublicRouteEnv = {
  UK_AQ_MEDIA_PUBLIC_URL?: unknown;
  UK_AQ_CACHE_ALLOWED_ORIGINS?: unknown;
};

type UpstreamResolution =
  | { ok: true; url: URL }
  | { ok: false; error: "media_upstream_not_configured" | "media_upstream_invalid" };

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch (_error) {
    return null;
  }
}

function parseAllowedOrigins(value: unknown): Set<string> {
  const origins = new Set<string>();
  stringValue(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (entry === "*") {
        origins.add(entry);
        return;
      }
      const origin = normalizeOrigin(entry);
      if (origin) origins.add(origin);
    });
  return origins;
}

function appendVaryOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Origin");
    return;
  }
  const values = current.split(",").map((value) => value.trim());
  if (!values.includes("Origin")) {
    headers.set("Vary", `${current}, Origin`);
  }
}

function applyCors(headers: Headers, allowedOrigin: string | null): void {
  if (!allowedOrigin) return;
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  appendVaryOrigin(headers);
}

function jsonError(status: number, error: string, message: string, allowedOrigin: string | null): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  applyCors(headers, allowedOrigin);
  return new Response(JSON.stringify({ ok: false, error, message }), { status, headers });
}

function resolveAllowedOrigin(request: Request, env: MediaPublicRouteEnv):
  | { ok: true; origin: string | null }
  | { ok: false; response: Response } {
  const rawOrigin = request.headers.get("Origin");
  if (!rawOrigin) return { ok: true, origin: null };

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) {
    return {
      ok: false,
      response: jsonError(403, "origin_not_allowed", "Request origin is not allowed", null),
    };
  }

  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin) return { ok: true, origin };

  const allowedOrigins = parseAllowedOrigins(env.UK_AQ_CACHE_ALLOWED_ORIGINS);
  if (allowedOrigins.size === 0) {
    return {
      ok: false,
      response: jsonError(500, "missing_allowed_origins", "Allowed origins are not configured", null),
    };
  }
  if (allowedOrigins.has("*") || allowedOrigins.has(origin)) {
    return { ok: true, origin };
  }
  return {
    ok: false,
    response: jsonError(403, "origin_not_allowed", "Request origin is not allowed", null),
  };
}

function resolveUpstream(env: MediaPublicRouteEnv): UpstreamResolution {
  const configured = stringValue(env.UK_AQ_MEDIA_PUBLIC_URL);
  if (!configured) return { ok: false, error: "media_upstream_not_configured" };

  let baseUrl: URL;
  try {
    baseUrl = new URL(configured);
  } catch (_error) {
    return { ok: false, error: "media_upstream_invalid" };
  }
  if (
    baseUrl.protocol !== "https:"
    || !baseUrl.hostname
    || baseUrl.username
    || baseUrl.password
    || baseUrl.pathname !== "/"
    || baseUrl.search
    || baseUrl.hash
  ) {
    return { ok: false, error: "media_upstream_invalid" };
  }

  return { ok: true, url: new URL(MEDIA_PUBLIC_UPSTREAM_PATH, baseUrl) };
}

function relayResponse(upstreamResponse: Response, allowedOrigin: string | null): Response {
  const headers = new Headers();
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  applyCors(headers, allowedOrigin);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export async function handleMediaPublicRequest(
  request: Request,
  env: MediaPublicRouteEnv,
): Promise<Response> {
  const originResolution = resolveAllowedOrigin(request, env);
  if (!originResolution.ok) return originResolution.response;
  const allowedOrigin = originResolution.origin;

  if (request.method !== "GET") {
    const response = jsonError(405, "method_not_allowed", "Only GET is supported", allowedOrigin);
    response.headers.set("Allow", "GET");
    return response;
  }

  const requestUrl = new URL(request.url);
  for (const name of requestUrl.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(name)) {
      return jsonError(
        400,
        "unsupported_query_parameter",
        "Only limit and before query parameters are supported",
        allowedOrigin,
      );
    }
  }

  const upstream = resolveUpstream(env);
  if (!upstream.ok) {
    const message = upstream.error === "media_upstream_not_configured"
      ? "Media public upstream is not configured"
      : "Media public upstream configuration is invalid";
    return jsonError(500, upstream.error, message, allowedOrigin);
  }
  for (const [name, value] of requestUrl.searchParams.entries()) {
    upstream.url.searchParams.append(name, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MEDIA_PUBLIC_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream.url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (_error) {
    const timedOut = controller.signal.aborted;
    return jsonError(
      timedOut ? 504 : 502,
      timedOut ? "media_upstream_timeout" : "media_upstream_unavailable",
      timedOut ? "Media public upstream timed out" : "Media public upstream is unavailable",
      allowedOrigin,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    if (upstreamResponse.body) {
      try {
        await upstreamResponse.body.cancel();
      } catch (_error) {
        // The redirect still fails closed even if cancelling its body is unsuccessful.
      }
    }
    return jsonError(502, "media_upstream_redirect", "Media public upstream redirected unexpectedly", allowedOrigin);
  }

  return relayResponse(upstreamResponse, allowedOrigin);
}
