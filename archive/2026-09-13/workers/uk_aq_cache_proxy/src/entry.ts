import cacheProxy, { type Env as CacheProxyEnv } from "./index.ts";
import {
  handleMediaPublicRequest,
  MEDIA_PUBLIC_API_PATH,
  type MediaPublicRouteEnv,
} from "./media_public_route.ts";
import {
  handleWhoSummaryProxyRequest,
  WHO_SUMMARY_API_PATH,
  type WhoSummaryProxyEnv,
} from "./who_summary_route.ts";

type Env = CacheProxyEnv & MediaPublicRouteEnv & WhoSummaryProxyEnv;

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MEDIA_PUBLIC_API_PATH) {
      return handleMediaPublicRequest(request, env);
    }
    if (url.pathname === WHO_SUMMARY_API_PATH) {
      return handleWhoSummaryProxyRequest(request, env, ctx);
    }
    return cacheProxy.fetch(request, env, ctx);
  },
};
