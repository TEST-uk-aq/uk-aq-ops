const DEFAULT_LATEST_SNAPSHOT_PREFIX = "latest_snapshots/v1";
const DEFAULT_LATEST_SNAPSHOT_MANIFEST_KEY = `${DEFAULT_LATEST_SNAPSHOT_PREFIX}/manifest.json`;
const DEFAULT_CACHE_SECONDS = 60;
const MAX_CACHE_SECONDS = 604800;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";

const VALID_WINDOWS = new Set(["3h", "6h", "1d"]);
const VALID_NETWORK_GROUPS = new Set(["all"]);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match, x-uk-aq-upstream-auth",
  };
}

function cacheControlHeader(cacheSeconds) {
  return `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`;
}

function normalizePrefix(raw) {
  return String(raw || "").trim().replace(/^\/+|\/+$/g, "");
}

function parsePositiveInt(raw, fallback, min = 1, max = 100000) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const value = Math.trunc(num);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizePollutant(raw) {
  const compact = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!compact) {
    return null;
  }
  if (compact === "pm25") {
    return "pm25";
  }
  if (compact === "pm10") {
    return "pm10";
  }
  if (compact === "no2") {
    return "no2";
  }
  return null;
}

function normalizeWindow(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return "6h";
  }
  return VALID_WINDOWS.has(value) ? value : null;
}

function normalizeNetworkGroup(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) {
    return "all";
  }
  return VALID_NETWORK_GROUPS.has(value) ? value : null;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request, env) {
  const expected = String(env.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!expected) {
    return { ok: false, status: 500, error: "Missing UK_AQ_EDGE_UPSTREAM_SECRET." };
  }
  const supplied = String(request.headers.get(UPSTREAM_AUTH_HEADER) || "").trim();
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}

function jsonResponse(payload, {
  status = 200,
  cacheSeconds = DEFAULT_CACHE_SECONDS,
  extraHeaders = {},
} = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControlHeader(cacheSeconds),
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function withError(status, message) {
  return jsonResponse({ error: message }, { status, cacheSeconds: 30 });
}

function setObjectHeaders(headers, object, cacheSeconds) {
  headers.set("Cache-Control", cacheControlHeader(cacheSeconds));
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/json; charset=utf-8");
  const etag = object.httpEtag || (object.etag ? `"${object.etag}"` : null);
  if (etag) {
    headers.set("ETag", etag);
  }
  if (object.size !== undefined && object.size !== null) {
    headers.set("Content-Length", String(object.size));
  }
  if (object.uploaded) {
    headers.set("Last-Modified", new Date(object.uploaded).toUTCString());
  }
}

function buildSnapshotKey(prefix, networkGroup, pollutant, windowLabel) {
  return `${prefix}/network_group=${networkGroup}/pollutant=${pollutant}/window=${windowLabel}.json`;
}

async function getObjectResponse(env, key, method, cacheSeconds, ifNoneMatchHeader) {
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) {
    return withError(404, "snapshot_not_found");
  }

  const etag = object.httpEtag || (object.etag ? `"${object.etag}"` : null);
  const ifNoneMatch = String(method === "GET" || method === "HEAD" ? (ifNoneMatchHeader || "") : "").trim();
  if (ifNoneMatch && etag && ifNoneMatch === etag) {
    const headers = new Headers(corsHeaders());
    headers.set("Cache-Control", cacheControlHeader(cacheSeconds));
    headers.set("ETag", etag);
    return new Response(null, { status: 304, headers });
  }

  const headers = new Headers(corsHeaders());
  setObjectHeaders(headers, object, cacheSeconds);

  if (method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(),
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withError(405, "method_not_allowed");
    }

    const auth = authorized(request, env);
    if (!auth.ok) {
      return withError(auth.status, auth.error);
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    const cacheSeconds = parsePositiveInt(
      env.UK_AQ_LATEST_SNAPSHOT_R2_CACHE_MAX_AGE_SECONDS,
      DEFAULT_CACHE_SECONDS,
      30,
      MAX_CACHE_SECONDS,
    );
    const prefix = normalizePrefix(env.UK_AQ_LATEST_SNAPSHOT_R2_PREFIX || DEFAULT_LATEST_SNAPSHOT_PREFIX)
      || DEFAULT_LATEST_SNAPSHOT_PREFIX;
    const manifestKey = normalizePrefix(
      env.UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY || `${prefix}/manifest.json`,
    ) || DEFAULT_LATEST_SNAPSHOT_MANIFEST_KEY;

    const requestIfNoneMatch = request.headers.get("If-None-Match") || "";

    if (pathname === "/" || pathname === "/v1/latest-snapshot") {
      const pollutant = normalizePollutant(url.searchParams.get("pollutant"));
      const windowLabel = normalizeWindow(url.searchParams.get("window"));
      const networkGroup = normalizeNetworkGroup(
        url.searchParams.get("network_group") || url.searchParams.get("scope") || "all",
      );

      if (!pollutant) {
        return withError(400, "invalid_pollutant");
      }
      if (!windowLabel) {
        return withError(400, "invalid_window");
      }
      if (!networkGroup) {
        return withError(400, "invalid_network_group");
      }

      const key = buildSnapshotKey(prefix, networkGroup, pollutant, windowLabel);
      return await getObjectResponse(env, key, request.method, cacheSeconds, requestIfNoneMatch);
    }

    if (pathname === "/v1/manifest") {
      return await getObjectResponse(env, manifestKey, request.method, cacheSeconds, requestIfNoneMatch);
    }

    if (pathname === "/v1/health") {
      return jsonResponse({
        ok: true,
        generated_at: new Date().toISOString(),
        prefix,
        manifest_key: manifestKey,
      }, { cacheSeconds: 30 });
    }

    return withError(404, "not_found");
  },
};
