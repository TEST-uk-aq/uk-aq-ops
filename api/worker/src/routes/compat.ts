import { errorEnvelope } from "../lib/http";
import { proxyToUpstream, type WorkerEnv } from "../lib/upstream";

const GET_ROUTES = new Set([
  "/api/config",
  "/api/snapshot",
  "/api/dashboard",
  "/api/storage_coverage",
  "/api/r2_metrics",
  "/api/r2_connector_counts",
]);

const POST_ROUTES = new Set([
  "/api/connectors",
  "/api/dispatcher_settings",
]);

const GET_ROUTE_CACHE_SECONDS: Record<string, number> = {
  "/api/config": 600,
  "/api/snapshot": 30,
  "/api/dashboard": 60,
  "/api/storage_coverage": 300,
  "/api/r2_metrics": 300,
  "/api/r2_connector_counts": 300,
};

function shouldBypassCache(request: Request): boolean {
  const search = new URL(request.url).searchParams;
  const bypassKeys = ["force", "refresh", "nocache", "cache_bust", "cacheBust", "t", "ts"];
  for (const key of bypassKeys) {
    const value = String(search.get(key) || "").trim().toLowerCase();
    if (!value) {
      continue;
    }
    if (value === "1" || value === "true" || value === "yes" || key === "t" || key === "ts") {
      return true;
    }
  }
  return false;
}

export function isCompatRoute(pathname: string): boolean {
  return GET_ROUTES.has(pathname) || POST_ROUTES.has(pathname);
}

export async function handleCompatRoute(
  request: Request,
  env: WorkerEnv,
  pathname: string,
): Promise<Response> {
  const method = request.method.toUpperCase();

  if (GET_ROUTES.has(pathname)) {
    if (method !== "GET") {
      return errorEnvelope("METHOD_NOT_ALLOWED", "Only GET is supported for this route", 405);
    }
    return proxyToUpstream(request, env, pathname, {
      cacheTtlSeconds: GET_ROUTE_CACHE_SECONDS[pathname] ?? 0,
      staleWhileRevalidateSeconds: 60,
      bypassCache: shouldBypassCache(request),
    });
  }

  if (POST_ROUTES.has(pathname)) {
    if (method !== "POST") {
      return errorEnvelope("METHOD_NOT_ALLOWED", "Only POST is supported for this route", 405);
    }
    return proxyToUpstream(request, env, pathname);
  }

  return errorEnvelope("NOT_FOUND", "Route not found", 404);
}
