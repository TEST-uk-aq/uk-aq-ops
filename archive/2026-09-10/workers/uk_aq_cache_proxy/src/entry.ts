import cacheProxy, { type Env as CacheProxyEnv } from "./index.ts";
import {
  handleWhoSummaryProxyRequest,
  WHO_SUMMARY_API_PATH,
  type WhoSummaryProxyEnv,
} from "./who_summary_route.ts";

type Env = CacheProxyEnv & WhoSummaryProxyEnv;

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === WHO_SUMMARY_API_PATH) {
      return handleWhoSummaryProxyRequest(request, env, ctx);
    }
    return cacheProxy.fetch(request, env, ctx);
  },
};
