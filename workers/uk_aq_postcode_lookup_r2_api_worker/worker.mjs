import {
  formatPostcode,
  getPostcodeShard,
  normalisePostcode,
} from "../shared/postcode_lookup.mjs";

const DEFAULT_POSTCODE_PREFIX = "v1";
const SUCCESS_CACHE_CONTROL = "public, max-age=86400";
const SHARD_CACHE_MAX_ENTRIES = 32;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const VALID_PATHS = new Set([
  "/",
  "/v1/postcode_lookup",
  "/v1/postcode-lookup",
  "/api/postcode_lookup",
]);

const shardCache = new Map();

function normalizePrefix(raw) {
  return String(raw || "").trim().replace(/^\/+|\/+$/g, "");
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-uk-aq-upstream-auth",
  };
}

function jsonResponse(payload, status, cacheControl) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...corsHeaders(),
    },
  });
}

function getShardCacheKey(prefix, shard) {
  return `${prefix}/${shard}`;
}

function getCachedShard(prefix, shard) {
  const key = getShardCacheKey(prefix, shard);
  if (!shardCache.has(key)) {
    return null;
  }
  const value = shardCache.get(key);
  shardCache.delete(key);
  shardCache.set(key, value);
  return value;
}

function setCachedShard(prefix, shard, value) {
  const key = getShardCacheKey(prefix, shard);
  if (shardCache.has(key)) {
    shardCache.delete(key);
  }
  shardCache.set(key, value);
  while (shardCache.size > SHARD_CACHE_MAX_ENTRIES) {
    const oldestKey = shardCache.keys().next().value;
    shardCache.delete(oldestKey);
  }
}

function ensureBucket(env) {
  const bucket = env?.UK_AQ_POSTCODE_LOOKUP_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("Missing R2 binding UK_AQ_POSTCODE_LOOKUP_BUCKET.");
  }
  return bucket;
}

async function readShardFromR2(env, prefix, shard) {
  const cached = getCachedShard(prefix, shard);
  if (cached) {
    return {
      ok: true,
      source: cached.source,
      postcodes: cached.postcodes,
    };
  }

  const objectKey = `${prefix}/${shard}.json`;
  let object;
  try {
    object = await ensureBucket(env).get(objectKey);
  } catch (_err) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  if (!object) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  let parsed;
  try {
    parsed = await object.json();
  } catch (_err) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  const postcodes = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed.postcodes
    : null;
  if (!postcodes || typeof postcodes !== "object" || Array.isArray(postcodes)) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  const normalized = {
    source: String(parsed.source || "ONSPD"),
    postcodes,
  };
  setCachedShard(prefix, shard, normalized);
  return {
    ok: true,
    source: normalized.source,
    postcodes: normalized.postcodes,
  };
}

function getLatLonFromShard(postcodes, postcode) {
  const value = postcodes[postcode];
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const lat = Number(value[0]);
  const lon = Number(value[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
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
  const expected = String(env?.UK_AQ_EDGE_UPSTREAM_SECRET || "").trim();
  if (!expected) {
    return {
      ok: false,
      status: 500,
      payload: {
        ok: false,
        error: "postcode_lookup_unavailable",
        message: "Postcode lookup is temporarily unavailable.",
      },
    };
  }
  const supplied = String(request.headers.get(UPSTREAM_AUTH_HEADER) || "").trim();
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    return {
      ok: false,
      status: 401,
      payload: {
        ok: false,
        error: "unauthorized",
        message: "Unauthorized.",
      },
    };
  }
  return { ok: true };
}

export async function handlePostcodeLookupRequest(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      { ok: false, error: "method_not_allowed", message: "Only GET is supported." },
      405,
      "no-store",
    );
  }

  const url = new URL(request.url);
  const postcodeRaw = String(url.searchParams.get("postcode") || "");
  const postcodeNormalised = normalisePostcode(postcodeRaw);
  if (!postcodeNormalised) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_postcode",
        message: "Enter a valid UK postcode.",
      },
      400,
      "no-store",
    );
  }

  const shard = getPostcodeShard(postcodeNormalised);
  if (!shard) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_postcode",
        message: "Enter a valid UK postcode.",
      },
      400,
      "no-store",
    );
  }

  const prefix = normalizePrefix(env?.UK_AQ_POSTCODE_R2_PREFIX || DEFAULT_POSTCODE_PREFIX);
  const shardLookup = await readShardFromR2(env, prefix, shard);
  if (!shardLookup.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "postcode_lookup_unavailable",
        message: "Postcode lookup is temporarily unavailable.",
      },
      503,
      "no-store",
    );
  }

  const coords = getLatLonFromShard(shardLookup.postcodes, postcodeNormalised);
  if (!coords) {
    return jsonResponse(
      {
        ok: false,
        error: "postcode_not_found",
        message: "Postcode not found.",
      },
      404,
      "no-store",
    );
  }

  return jsonResponse(
    {
      ok: true,
      postcode: formatPostcode(postcodeNormalised),
      postcode_normalised: postcodeNormalised,
      lat: coords.lat,
      lon: coords.lon,
      source: shardLookup.source || "ONSPD",
    },
    200,
    SUCCESS_CACHE_CONTROL,
  );
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (!VALID_PATHS.has(pathname)) {
      return jsonResponse(
        {
          ok: false,
          error: "not_found",
          message: "Route not found.",
        },
        404,
        "no-store",
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    }

    const authResult = authorized(request, env);
    if (!authResult.ok) {
      return jsonResponse(authResult.payload, authResult.status, "no-store");
    }

    return handlePostcodeLookupRequest(request, env);
  },
};
