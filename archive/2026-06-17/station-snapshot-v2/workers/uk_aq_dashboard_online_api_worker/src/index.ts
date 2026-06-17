import { errorEnvelope, optionsResponse } from "./lib/http";
import { isCompatRoute, handleCompatRoute } from "./routes/compat";
import {
  handleHealthRoute,
  handleHistoryManifestsRoute,
  handleHistoryRunsRoute,
  handleStatusDbRoute,
  handleStatusFeedsRoute,
  handleStatusHistoryRoute,
  handleStatusSummaryRoute,
} from "./routes/status";
import type { WorkerEnv } from "./lib/upstream";

function getPathname(request: Request): string {
  return new URL(request.url).pathname;
}

function isApiRoute(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const pathname = getPathname(request);

    if (request.method === "OPTIONS" && isApiRoute(pathname)) {
      return optionsResponse();
    }

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        return errorEnvelope("METHOD_NOT_ALLOWED", "Only GET is supported for this route", 405);
      }
      return handleHealthRoute(env);
    }

    const search = new URL(request.url).searchParams;

    if (pathname === "/api/status/summary") {
      return handleStatusSummaryRoute(env, search);
    }
    if (pathname === "/api/status/feeds") {
      return handleStatusFeedsRoute(env, search);
    }
    if (pathname === "/api/status/db") {
      return handleStatusDbRoute(env, search);
    }
    if (pathname === "/api/status/history") {
      return handleStatusHistoryRoute(env, search);
    }
    if (pathname === "/api/history/manifests") {
      return handleHistoryManifestsRoute(env, search);
    }
    if (pathname === "/api/history/runs") {
      return handleHistoryRunsRoute(env, search);
    }

    if (isCompatRoute(pathname)) {
      return handleCompatRoute(request, env, pathname);
    }

    if (isApiRoute(pathname)) {
      return errorEnvelope("NOT_FOUND", "API route not found", 404);
    }

    return errorEnvelope("NOT_FOUND", "Not found", 404);
  },
};
