import observationsHistoryWorker from "./worker.mjs";
import {
  handleWhoSummaryUpstreamRequest,
  WHO_SUMMARY_UPSTREAM_PATH,
} from "./who_summary_route.mjs";
import { handleBcUvDiurnalUpstreamRequest, BC_UV_DIURNAL_UPSTREAM_PATH } from "./bc_uv_diurnal_route.mjs";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === WHO_SUMMARY_UPSTREAM_PATH) {
      return handleWhoSummaryUpstreamRequest(request, env, ctx);
    }
    if (url.pathname === BC_UV_DIURNAL_UPSTREAM_PATH) {
      return handleBcUvDiurnalUpstreamRequest(request, env, ctx);
    }
    return observationsHistoryWorker.fetch(request, env, ctx);
  },
};
