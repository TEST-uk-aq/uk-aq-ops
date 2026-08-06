export const WHO_SUMMARY_UPSTREAM_PATH = "/v1/who-summary";
export const WHO_SUMMARY_R2_KEY = "history/v2/who_2021/latest_who_2021.json";

const CACHE_CONTRACT_VERSION = "1";
const CURRENT_TTL_SECONDS = 86_400;
const BEHIND_TTL_SECONDS = 1_800;
const STALE_IF_ERROR_SECONDS = 86_400;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, x-uk-aq-upstream-auth",
  };
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ ok: false, error: code, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(),
    },
  });
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function authorised(request, env) {
  const expected = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!expected) return { ok: false, status: 500, error: "missing_upstream_secret" };
  const supplied = String(request.headers.get(UPSTREAM_AUTH_HEADER) || "").trim();
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "unauthorised" };
  }
  return { ok: true };
}

function isValidUtcDay(value) {
  if (!ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function freshnessFor(dataAsOfDayUtc, requestedAsOfDayUtc) {
  if (dataAsOfDayUtc === requestedAsOfDayUtc) return "current";
  return dataAsOfDayUtc < requestedAsOfDayUtc ? "behind" : "ahead";
}

function cacheControlFor(freshness) {
  const ttl = freshness === "behind" ? BEHIND_TTL_SECONDS : CURRENT_TTL_SECONDS;
  return `public, max-age=${ttl}, s-maxage=${ttl}, stale-if-error=${STALE_IF_ERROR_SECONDS}`;
}

function canonicalCacheRequest(request, requestedAsOfDayUtc) {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = WHO_SUMMARY_UPSTREAM_PATH;
  cacheUrl.search = "";
  cacheUrl.searchParams.set("as_of", requestedAsOfDayUtc);
  cacheUrl.searchParams.set("__uk_aq_who_contract", CACHE_CONTRACT_VERSION);
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function responseForMethod(request, response) {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function withOriginCacheStatus(response, cacheStatus) {
  const headers = new Headers(response.headers);
  headers.set("X-UK-AQ-WHO-Origin-Cache", cacheStatus);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleWhoSummaryUpstreamRequest(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders(), "Cache-Control": "no-store" },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store", ...corsHeaders() },
    });
  }

  const authResult = authorised(request, env);
  if (!authResult.ok) {
    return jsonError(authResult.status, authResult.error, "WHO summary upstream request was not authorised");
  }

  const requestUrl = new URL(request.url);
  const requestedAsOfDayUtc = String(requestUrl.searchParams.get("as_of") || "").trim();
  if (!isValidUtcDay(requestedAsOfDayUtc)) {
    return jsonError(400, "invalid_as_of", "as_of must be a valid UTC day in YYYY-MM-DD format");
  }

  if (!env.UK_AQ_HISTORY_BUCKET) {
    return jsonError(500, "missing_r2_binding", "WHO summary R2 binding is not configured");
  }

  const cacheRequest = canonicalCacheRequest(request, requestedAsOfDayUtc);
  const cached = await caches.default.match(cacheRequest);
  if (cached) {
    return responseForMethod(request, withOriginCacheStatus(cached, "HIT"));
  }

  let object;
  try {
    object = await env.UK_AQ_HISTORY_BUCKET.get(WHO_SUMMARY_R2_KEY);
  } catch (error) {
    console.error("WHO summary R2 read failed", error);
    return jsonError(502, "r2_read_failed", "WHO summary could not be read from R2");
  }

  if (!object) {
    return jsonError(404, "who_summary_not_found", "WHO summary JSON is not available yet");
  }

  let bodyText;
  let payload;
  try {
    bodyText = await object.text();
    payload = JSON.parse(bodyText);
  } catch (error) {
    console.error("WHO summary JSON parse failed", error);
    return jsonError(502, "invalid_who_summary_json", "WHO summary JSON is invalid");
  }

  const dataAsOfDayUtc = String(payload?.data_as_of_day_utc || "").trim();
  if (!isValidUtcDay(dataAsOfDayUtc) || !Array.isArray(payload?.cards)) {
    return jsonError(
      502,
      "invalid_who_summary_contract",
      "WHO summary JSON is missing data_as_of_day_utc or cards",
    );
  }

  const freshness = freshnessFor(dataAsOfDayUtc, requestedAsOfDayUtc);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControlFor(freshness),
    "X-Content-Type-Options": "nosniff",
    "X-UK-AQ-WHO-Requested-As-Of": requestedAsOfDayUtc,
    "X-UK-AQ-WHO-Data-As-Of": dataAsOfDayUtc,
    "X-UK-AQ-WHO-Freshness": freshness,
    "X-UK-AQ-WHO-Origin-Cache": "MISS",
    ...corsHeaders(),
  });
  const etag = String(object.httpEtag || object.etag || "").trim();
  if (etag) headers.set("ETag", etag);
  if (freshness === "behind") {
    headers.set("X-UK-AQ-WHO-Retry-After-Seconds", String(BEHIND_TTL_SECONDS));
  }

  const response = new Response(bodyText, { status: 200, headers });
  ctx.waitUntil(
    caches.default.put(cacheRequest, response.clone()).catch((error) => {
      console.warn("WHO summary origin cache write failed", error);
    }),
  );
  return responseForMethod(request, response);
}
