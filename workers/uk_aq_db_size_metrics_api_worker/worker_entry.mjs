import worker from "./worker.mjs";
import { normaliseOptionalAqilevelsCountsPayload } from "./optional_aqilevels.mjs";

const R2_HISTORY_COUNTS_PATHS = new Set([
  "/r2-history-counts",
  "/v1/r2-history-counts",
]);

async function normaliseR2HistoryCountsResponse(response) {
  if (!response.ok) {
    return response;
  }
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return response;
  }

  let payload;
  try {
    payload = await response.clone().json();
  } catch (_error) {
    return response;
  }

  const normalised = normaliseOptionalAqilevelsCountsPayload(payload);
  if (normalised === payload) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(normalised), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const response = await worker.fetch(request, env, ctx);
    if (request.method.toUpperCase() !== "GET") {
      return response;
    }
    const pathname = new URL(request.url).pathname;
    if (!R2_HISTORY_COUNTS_PATHS.has(pathname)) {
      return response;
    }
    return normaliseR2HistoryCountsResponse(response);
  },
};
