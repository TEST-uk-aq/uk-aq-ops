export const WHO_SUMMARY_UPSTREAM_PATH = "/v1/who-summary";
export const WHO_SUMMARY_R2_KEY = "history/v2/who_2021/latest_who_2021.json";

const CACHE_CONTRACT_VERSION = "2";
const VALIDATED_BODY_CACHE_SECONDS = 604_800;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const CACHED_R2_ETAG_HEADER = "x-uk-aq-who-cached-r2-etag";
const CACHED_R2_HTTP_ETAG_HEADER = "x-uk-aq-who-cached-r2-http-etag";
const CACHED_R2_VERSION_HEADER = "x-uk-aq-who-cached-r2-version";
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

function validatedBodyCacheRequest(request) {
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = WHO_SUMMARY_UPSTREAM_PATH;
  cacheUrl.search = "";
  cacheUrl.searchParams.set("__uk_aq_who_body_contract", CACHE_CONTRACT_VERSION);
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

function parseAndValidatePayload(bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (_error) {
    return { ok: false, error: "invalid_who_summary_json" };
  }

  const dataAsOfDayUtc = String(payload?.data_as_of_day_utc || "").trim();
  if (!isValidUtcDay(dataAsOfDayUtc) || !Array.isArray(payload?.cards)) {
    return { ok: false, error: "invalid_who_summary_contract" };
  }
  return { ok: true, payload, dataAsOfDayUtc };
}

function httpEtagFor(rawEtag) {
  if (!rawEtag) return "";
  return rawEtag.startsWith('"') && rawEtag.endsWith('"')
    ? rawEtag
    : `"${rawEtag}"`;
}

function r2Identity(object, fallback = {}) {
  const rawEtag = String(object?.etag || fallback.rawEtag || "").trim();
  const httpEtag = String(object?.httpEtag || fallback.httpEtag || httpEtagFor(rawEtag)).trim();
  const version = String(object?.version || fallback.version || "").trim();
  return { rawEtag, httpEtag, version };
}

async function readValidatedBodyCache(cacheRequest) {
  let cached;
  try {
    cached = await caches.default.match(cacheRequest);
  } catch (error) {
    console.warn("WHO summary validated-body cache read failed", error);
    return null;
  }
  if (!cached) return null;

  const rawEtag = String(cached.headers.get(CACHED_R2_ETAG_HEADER) || "").trim();
  if (!rawEtag) {
    console.warn("WHO summary validated-body cache is missing its R2 ETag");
    return null;
  }

  let bodyText;
  try {
    bodyText = await cached.text();
  } catch (error) {
    console.warn("WHO summary validated-body cache could not be read", error);
    return null;
  }
  const validated = parseAndValidatePayload(bodyText);
  if (!validated.ok) {
    console.warn("WHO summary validated-body cache failed validation", validated.error);
    return null;
  }

  return {
    bodyText,
    dataAsOfDayUtc: validated.dataAsOfDayUtc,
    rawEtag,
    httpEtag: String(cached.headers.get(CACHED_R2_HTTP_ETAG_HEADER) || httpEtagFor(rawEtag)).trim(),
    version: String(cached.headers.get(CACHED_R2_VERSION_HEADER) || "").trim(),
  };
}

async function retainValidatedBody(cacheRequest, bodyText, identity) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": `public, max-age=${VALIDATED_BODY_CACHE_SECONDS}`,
    [CACHED_R2_ETAG_HEADER]: identity.rawEtag,
    [CACHED_R2_HTTP_ETAG_HEADER]: identity.httpEtag || httpEtagFor(identity.rawEtag),
  });
  if (identity.version) headers.set(CACHED_R2_VERSION_HEADER, identity.version);
  try {
    await caches.default.put(cacheRequest, new Response(bodyText, { status: 200, headers }));
  } catch (error) {
    console.warn("WHO summary validated-body cache write failed", error);
  }
}

function successfulResponse({
  bodyText,
  dataAsOfDayUtc,
  requestedAsOfDayUtc,
  originCacheStatus,
  identity,
  staleReason = "",
}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-UK-AQ-WHO-Requested-As-Of": requestedAsOfDayUtc,
    "X-UK-AQ-WHO-Data-As-Of": dataAsOfDayUtc,
    "X-UK-AQ-WHO-Freshness": freshnessFor(dataAsOfDayUtc, requestedAsOfDayUtc),
    "X-UK-AQ-WHO-Origin-Cache": originCacheStatus,
    ...corsHeaders(),
  });
  if (identity.rawEtag) headers.set("X-UK-AQ-WHO-R2-ETag", identity.rawEtag);
  if (identity.httpEtag) headers.set("ETag", identity.httpEtag);
  if (identity.version) headers.set("X-UK-AQ-WHO-R2-Version", identity.version);
  if (staleReason) headers.set("X-UK-AQ-WHO-Stale-Reason", staleReason);
  return new Response(bodyText, { status: 200, headers });
}

function hasBody(object) {
  return Boolean(object && object.body !== undefined && typeof object.text === "function");
}

export async function handleWhoSummaryUpstreamRequest(request, env, _ctx) {
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
    return responseForMethod(
      request,
      jsonError(authResult.status, authResult.error, "WHO summary upstream request was not authorised"),
    );
  }

  const requestUrl = new URL(request.url);
  const requestedAsOfDayUtc = String(requestUrl.searchParams.get("as_of") || "").trim();
  if (!isValidUtcDay(requestedAsOfDayUtc)) {
    return responseForMethod(
      request,
      jsonError(400, "invalid_as_of", "as_of must be a valid UTC day in YYYY-MM-DD format"),
    );
  }

  if (!env.UK_AQ_HISTORY_BUCKET) {
    return responseForMethod(
      request,
      jsonError(500, "missing_r2_binding", "WHO summary R2 binding is not configured"),
    );
  }

  const cacheRequest = validatedBodyCacheRequest(request);
  const cached = await readValidatedBodyCache(cacheRequest);
  let object;
  try {
    object = cached
      ? await env.UK_AQ_HISTORY_BUCKET.get(WHO_SUMMARY_R2_KEY, {
        onlyIf: { etagDoesNotMatch: cached.rawEtag },
      })
      : await env.UK_AQ_HISTORY_BUCKET.get(WHO_SUMMARY_R2_KEY);
  } catch (error) {
    console.error("WHO summary R2 read failed", error);
    if (cached) {
      const staleResponse = successfulResponse({
        bodyText: cached.bodyText,
        dataAsOfDayUtc: cached.dataAsOfDayUtc,
        requestedAsOfDayUtc,
        originCacheStatus: "STALE_R2_ERROR",
        identity: cached,
        staleReason: "r2_read_error",
      });
      return responseForMethod(request, staleResponse);
    }
    return responseForMethod(
      request,
      jsonError(502, "r2_read_failed", "WHO summary could not be read from R2"),
    );
  }

  if (!object) {
    return responseForMethod(
      request,
      jsonError(404, "who_summary_not_found", "WHO summary JSON is not available yet"),
    );
  }

  if (cached && !hasBody(object)) {
    const identity = r2Identity(object, cached);
    const response = successfulResponse({
      bodyText: cached.bodyText,
      dataAsOfDayUtc: cached.dataAsOfDayUtc,
      requestedAsOfDayUtc,
      originCacheStatus: "HIT_VALIDATED",
      identity,
    });
    return responseForMethod(request, response);
  }

  const identity = r2Identity(object);
  if (!identity.rawEtag) {
    return responseForMethod(
      request,
      jsonError(502, "invalid_r2_metadata", "WHO summary R2 object is missing its ETag"),
    );
  }

  let bodyText;
  try {
    bodyText = await object.text();
  } catch (error) {
    console.error("WHO summary R2 body read failed", error);
    if (cached) {
      const staleResponse = successfulResponse({
        bodyText: cached.bodyText,
        dataAsOfDayUtc: cached.dataAsOfDayUtc,
        requestedAsOfDayUtc,
        originCacheStatus: "STALE_R2_ERROR",
        identity: cached,
        staleReason: "r2_body_read_error",
      });
      return responseForMethod(request, staleResponse);
    }
    return responseForMethod(
      request,
      jsonError(502, "r2_read_failed", "WHO summary could not be read from R2"),
    );
  }

  const validated = parseAndValidatePayload(bodyText);
  if (!validated.ok) {
    console.error("WHO summary R2 payload failed validation", validated.error);
    const message = validated.error === "invalid_who_summary_json"
      ? "WHO summary JSON is invalid"
      : "WHO summary JSON is missing data_as_of_day_utc or cards";
    return responseForMethod(request, jsonError(502, validated.error, message));
  }

  await retainValidatedBody(cacheRequest, bodyText, identity);
  const response = successfulResponse({
    bodyText,
    dataAsOfDayUtc: validated.dataAsOfDayUtc,
    requestedAsOfDayUtc,
    originCacheStatus: cached ? "REFRESHED" : "MISS",
    identity,
  });
  return responseForMethod(request, response);
}
