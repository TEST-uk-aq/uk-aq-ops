import { errorEnvelope } from "../lib/http";
import { proxyToUpstream, type WorkerEnv } from "../lib/upstream";

const GET_ROUTES = new Set([
  "/api/dashboard",
  "/api/storage_coverage",
  "/api/r2_metrics",
  "/api/r2_connector_counts",
]);

const POST_ROUTES = new Set([
  "/api/connectors",
  "/api/dispatcher_settings",
]);

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
    return proxyToUpstream(request, env, pathname);
  }

  if (POST_ROUTES.has(pathname)) {
    if (method !== "POST") {
      return errorEnvelope("METHOD_NOT_ALLOWED", "Only POST is supported for this route", 405);
    }
    return proxyToUpstream(request, env, pathname);
  }

  return errorEnvelope("NOT_FOUND", "Route not found", 404);
}
