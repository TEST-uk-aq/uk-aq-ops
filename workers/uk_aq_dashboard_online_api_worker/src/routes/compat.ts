import { resolveHistoryEnvironment, historyResolution } from "../lib/history_generation";
import { errorEnvelope } from "../lib/http";
import { handleDirectCompatRoute } from "../lib/direct";
import {
  enrichStorageCoverageFromMetrics,
  proxyR2ConnectorCounts,
} from "../lib/r2_metrics_service";
import { enrichStorageCoverageResponse } from "../lib/storage_coverage_http_enrichment";
import { proxyToUpstream, shouldUseUpstream, type WorkerEnv } from "../lib/upstream";

const GET_ROUTES = new Set([
  "/api/config",
  "/api/snapshot",
  "/api/dashboard",
  "/api/storage_coverage",
  "/api/r2_metrics",
  "/api/r2_connector_counts",
  "/api/daily_task_runs",
  "/api/operations_dropbox_mtime",
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
  "/api/daily_task_runs": 120,
  "/api/operations_dropbox_mtime": 30,
};

function shouldBypassCache(request: Request, pathname: string): boolean {
  const search = new URL(request.url).searchParams;
  const bypassKeys = ["force", "refresh", "nocache", "cache_bust", "cacheBust"];
  const cacheBustKeys = pathname === "/api/dashboard" ? [] : ["t", "ts"];
  const keys = [...bypassKeys, ...cacheBustKeys];
  for (const key of keys) {
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
  const useUpstream = shouldUseUpstream(request, env);

  if (GET_ROUTES.has(pathname)) {
    if (method !== "GET") {
      return errorEnvelope("METHOD_NOT_ALLOWED", "Only GET is supported for this route", 405);
    }

    const historyRoute = ["/api/dashboard", "/api/storage_coverage", "/api/r2_metrics", "/api/r2_connector_counts"].includes(pathname);
    const requiresHistoryResolution =
      historyRoute || pathname === "/api/operations_dropbox_mtime";

    if (requiresHistoryResolution) {
      try { env = await resolveHistoryEnvironment(env); }
      catch { return errorEnvelope("HISTORY_AUTHORITY_UNAVAILABLE", "Stable history generation could not be resolved", 503); }
      // An upstream payload must not survive an authority switch in the proxy cache.
      const url = new URL(request.url);
      url.searchParams.set("__history_generation", historyResolution(env).version);
      request = new Request(url, request);
    }
    if (!useUpstream && pathname === "/api/r2_connector_counts") {
      const serviceResponse = await proxyR2ConnectorCounts(request, env);
      if (serviceResponse) return withHistoryDiagnostics(serviceResponse, env);
    }

    let response = !useUpstream
      ? await handleDirectCompatRoute(request, env, pathname)
      : await proxyToUpstream(request, env, pathname, {
          cacheTtlSeconds: GET_ROUTE_CACHE_SECONDS[pathname] ?? 0,
          staleWhileRevalidateSeconds: 60,
          bypassCache: shouldBypassCache(request, pathname),
          ignoredCacheSearchParams: pathname === "/api/dashboard"
            ? ["t", "ts", "dispatch_cursor"]
            : undefined,
        });

    if (historyRoute && useUpstream && response.ok) {
      const body = await response.clone().json() as Record<string, unknown>;
      const reportedDescriptor = body.r2_history_read_version;
      const reported = (reportedDescriptor && typeof reportedDescriptor === "object"
        ? (reportedDescriptor as Record<string, unknown>).version : null) || body.read_version;
      if (reported !== historyResolution(env).version) {
        return errorEnvelope("HISTORY_GENERATION_MISMATCH", "Upstream payload does not match serving history generation", 503);
      }
    }
    if (pathname === "/api/storage_coverage" || pathname === "/api/dashboard") {
      if (useUpstream) {
        response = await enrichStorageCoverageResponse(response, request, env);
      }
      response = await enrichStorageCoverageFromMetrics(response, request, env);
    }
    return historyRoute ? withHistoryDiagnostics(response, env) : response;
  }

  if (POST_ROUTES.has(pathname)) {
    if (method !== "POST") {
      return errorEnvelope("METHOD_NOT_ALLOWED", "Only POST is supported for this route", 405);
    }
    if (!useUpstream) {
      return handleDirectCompatRoute(request, env, pathname);
    }
    return proxyToUpstream(request, env, pathname);
  }

  return errorEnvelope("NOT_FOUND", "Route not found", 404);
}

async function withHistoryDiagnostics(response: Response, env: WorkerEnv): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.clone().json() as Record<string, unknown>;
  const resolution = historyResolution(env);
  body.r2_history_read_version = resolution;
  body.r2_history_read_version_effective = resolution;
  if (body.read_version) {
    if (body.read_version !== resolution.version) return errorEnvelope("HISTORY_GENERATION_MISMATCH", "History response generation mismatch", 503);
    body.metrics_read_version_source = body.read_version_source;
    body.read_version_source = resolution.source;
  }
  if (resolution.version === "v3" && "r2_domain_size_metrics" in body) {
    body.r2_domain_size_metrics = [];
    body.r2_domain_size_metrics_error = null;
    body.r2_domain_size_metrics_warning = "Historical domain byte metrics have no generation identity; unavailable for v3. Account usage remains account-wide.";
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}
