import {
  formatPostcode,
  normalisePostcode,
} from "../shared/postcode_lookup.mjs";

const DEFAULT_POSTCODE_PREFIX = "v1";
const SUCCESS_CACHE_CONTROL = "public, max-age=86400";
const SHARD_CACHE_MAX_ENTRIES = 32;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const MAX_SUGGEST_LIMIT = 10;
const DEFAULT_SUGGEST_LIMIT = 6;

const LOOKUP_PATHS = new Set([
  "/",
  "/v1/postcode_lookup",
  "/v1/postcode-lookup",
  "/api/postcode_lookup",
  "/api/postcode-lookup",
]);

const SUGGEST_PATHS = new Set([
  "/v1/postcode_suggest",
  "/v1/postcode-suggest",
  "/api/postcode_suggest",
  "/api/postcode-suggest",
]);

const VALID_PATHS = new Set([...LOOKUP_PATHS, ...SUGGEST_PATHS]);

const exactShardCache = new Map();
const suggestShardCache = new Map();

let areaTownIndexCacheKey = "";
let areaTownIndexCacheState = { status: "uninitialized", values: null };

let prefixHintsCacheKey = "";
let prefixHintsCacheState = {
  status: "uninitialized",
  hints: {
    prefixes_1: {},
    prefixes_2: {},
    postcode_samples_1: {},
    postcode_samples_2: {},
  },
};

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

function getCacheKey(prefix, key) {
  return `${prefix}/${key}`;
}

function getCachedValue(cache, prefix, key) {
  const cacheKey = getCacheKey(prefix, key);
  if (!cache.has(cacheKey)) {
    return null;
  }
  const value = cache.get(cacheKey);
  cache.delete(cacheKey);
  cache.set(cacheKey, value);
  return value;
}

function setCachedValue(cache, prefix, key, value) {
  const cacheKey = getCacheKey(prefix, key);
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey);
  }
  cache.set(cacheKey, value);
  while (cache.size > SHARD_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function ensureBucket(env) {
  const bucket = env?.UK_AQ_POSTCODE_LOOKUP_BUCKET;
  if (!bucket || typeof bucket.get !== "function") {
    throw new Error("Missing R2 binding UK_AQ_POSTCODE_LOOKUP_BUCKET.");
  }
  return bucket;
}

async function readJsonObjectFromR2(env, objectKey) {
  let object;
  try {
    object = await ensureBucket(env).get(objectKey);
  } catch (_err) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  if (!object) {
    return { ok: false, missing: true, object_key: objectKey };
  }

  let parsed;
  try {
    parsed = await object.json();
  } catch (_err) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  return { ok: true, payload: parsed, object_key: objectKey };
}

function getPostcodeAreaFromPrefix(postcodePrefix) {
  const match = String(postcodePrefix || "").match(/^[A-Z]+/);
  return match ? match[0] : null;
}

function parseCodeOrNull(value) {
  const compact = String(value || "").trim().toUpperCase();
  return compact || null;
}

function parseAreaTownId(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function getLookupRecordFromShard(postcodes, postcode) {
  const value = postcodes[postcode];

  if (Array.isArray(value)) {
    if (value.length < 2) {
      return null;
    }
    const lat = Number(value[0]);
    const lon = Number(value[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return {
      lat,
      lon,
      pcon_code: parseCodeOrNull(value[2]),
      la_code: parseCodeOrNull(value[3]),
      area_town_id: parseAreaTownId(value[4]),
    };
  }

  if (value && typeof value === "object") {
    const lat = Number(value.lat);
    const lon = Number(value.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return {
      lat,
      lon,
      pcon_code: parseCodeOrNull(value.pcon_code || value.pcon),
      la_code: parseCodeOrNull(value.la_code || value.la),
      area_town_id: parseAreaTownId(value.area_town_id),
    };
  }

  return null;
}

function normalizeSuggestQuery(raw) {
  const compact = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!compact) {
    return "";
  }
  if (compact.length > 8) {
    return null;
  }
  if (!/^[A-Z][A-Z0-9]*$/.test(compact)) {
    return null;
  }
  return compact;
}

function parseSuggestLimit(url) {
  const raw = String(url.searchParams.get("limit") || "").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SUGGEST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SUGGEST_LIMIT, parsed));
}

function getOutwardFromPostcodeNormalised(postcodeNormalised) {
  const compact = String(postcodeNormalised || "").trim().toUpperCase();
  if (!compact) {
    return "";
  }
  if (compact.length <= 3) {
    return compact;
  }
  return compact.slice(0, -3);
}

function getSuggestMatchRank(queryNormalised, postcodeNormalised) {
  const outward = getOutwardFromPostcodeNormalised(postcodeNormalised);
  if (!outward) {
    return 4;
  }
  if (outward === queryNormalised) {
    return 0;
  }
  if (outward.startsWith(queryNormalised)) {
    return 1;
  }
  if (queryNormalised.startsWith(outward)) {
    return 2;
  }
  return 3;
}

function parsePostcodeSampleRow(row) {
  if (Array.isArray(row)) {
    const postcodeNormalised = String(row[0] || "").trim().toUpperCase();
    const postcodeDisplay = String(row[1] || "").trim() || formatPostcode(postcodeNormalised);
    const areaTownId = parseAreaTownId(row[2]);
    if (!postcodeNormalised) {
      return null;
    }
    return {
      postcode_normalised: postcodeNormalised,
      postcode: postcodeDisplay,
      area_town_id: areaTownId,
    };
  }
  if (row && typeof row === "object") {
    const postcodeNormalised = String(row.n || row.postcode_normalised || "").trim().toUpperCase();
    const postcodeDisplay = String(row.p || row.postcode || "").trim() || formatPostcode(postcodeNormalised);
    const areaTownId = parseAreaTownId(row.at || row.area_town_id);
    if (!postcodeNormalised) {
      return null;
    }
    return {
      postcode_normalised: postcodeNormalised,
      postcode: postcodeDisplay,
      area_town_id: areaTownId,
    };
  }
  return null;
}

function valuesEqualInsensitive(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function buildPostcodeLabel(postcode, areaName, postTown) {
  const parts = [String(postcode || "").trim()].filter(Boolean);
  const area = String(areaName || "").trim();
  const town = String(postTown || "").trim();

  if (area && !parts.some((item) => valuesEqualInsensitive(item, area))) {
    parts.push(area);
  }
  if (town && !parts.some((item) => valuesEqualInsensitive(item, town))) {
    parts.push(town);
  }

  return parts.join(", ");
}

async function readExactShardFromR2(env, prefix, shard) {
  const cached = getCachedValue(exactShardCache, prefix, shard);
  if (cached) {
    return {
      ok: true,
      source: cached.source,
      postcodes: cached.postcodes,
      object_key: cached.object_key,
    };
  }

  const primaryKey = `${prefix}/shards/${shard}.json`;
  const primaryRead = await readJsonObjectFromR2(env, primaryKey);
  if (!primaryRead.ok && primaryRead.unavailable) {
    return { ok: false, unavailable: true, object_key: primaryKey };
  }

  let payload = null;
  let objectKey = primaryKey;
  if (primaryRead.ok) {
    payload = primaryRead.payload;
  } else if (primaryRead.missing) {
    const legacyKey = `${prefix}/${shard}.json`;
    const legacyRead = await readJsonObjectFromR2(env, legacyKey);
    if (!legacyRead.ok && legacyRead.unavailable) {
      return { ok: false, unavailable: true, object_key: legacyKey };
    }
    if (!legacyRead.ok && legacyRead.missing) {
      return { ok: false, missing: true, object_key: legacyKey };
    }
    payload = legacyRead.payload;
    objectKey = legacyKey;
  }

  const postcodes = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.postcodes
    : null;
  if (!postcodes || typeof postcodes !== "object" || Array.isArray(postcodes)) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  const normalized = {
    source: String(payload.source || "ONSPD"),
    postcodes,
    object_key: objectKey,
  };
  setCachedValue(exactShardCache, prefix, shard, normalized);
  return {
    ok: true,
    source: normalized.source,
    postcodes: normalized.postcodes,
    object_key: normalized.object_key,
  };
}

async function readSuggestShardFromR2(env, prefix, area) {
  const cached = getCachedValue(suggestShardCache, prefix, area);
  if (cached) {
    return { ok: true, rows: cached.rows, source: cached.source, object_key: cached.object_key };
  }

  const objectKey = `${prefix}/suggest/${area}.json`;
  const readResult = await readJsonObjectFromR2(env, objectKey);
  if (!readResult.ok) {
    return {
      ok: false,
      missing: Boolean(readResult.missing),
      unavailable: Boolean(readResult.unavailable),
      object_key: objectKey,
    };
  }

  const rows = Array.isArray(readResult.payload?.rows) ? readResult.payload.rows : null;
  if (!rows) {
    return { ok: false, unavailable: true, object_key: objectKey };
  }

  const normalizedRows = rows.filter((row) => Array.isArray(row) && row.length >= 3);
  const normalized = {
    rows: normalizedRows,
    source: String(readResult.payload?.source || "ONSPD"),
    object_key: objectKey,
  };
  setCachedValue(suggestShardCache, prefix, area, normalized);
  return {
    ok: true,
    rows: normalized.rows,
    source: normalized.source,
    object_key: normalized.object_key,
  };
}

async function readAreaTownIndex(env, prefix) {
  const cacheKey = `${prefix}/area_town_index.json`;
  if (areaTownIndexCacheKey === cacheKey && areaTownIndexCacheState.status !== "uninitialized") {
    return areaTownIndexCacheState;
  }

  const readResult = await readJsonObjectFromR2(env, cacheKey);
  if (!readResult.ok) {
    areaTownIndexCacheKey = cacheKey;
    areaTownIndexCacheState = {
      status: readResult.unavailable ? "unavailable" : "missing",
      values: null,
    };
    return areaTownIndexCacheState;
  }

  const values = readResult.payload && typeof readResult.payload === "object" && readResult.payload.values
    ? readResult.payload.values
    : null;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    areaTownIndexCacheKey = cacheKey;
    areaTownIndexCacheState = {
      status: "unavailable",
      values: null,
    };
    return areaTownIndexCacheState;
  }

  areaTownIndexCacheKey = cacheKey;
  areaTownIndexCacheState = {
    status: "ok",
    values,
  };
  return areaTownIndexCacheState;
}

async function readPrefixHints(env, prefix) {
  const cacheKey = `${prefix}/postcode_prefix_hints.json`;
  if (prefixHintsCacheKey === cacheKey && prefixHintsCacheState.status !== "uninitialized") {
    return prefixHintsCacheState;
  }

  const readResult = await readJsonObjectFromR2(env, cacheKey);
  if (!readResult.ok) {
    prefixHintsCacheKey = cacheKey;
    prefixHintsCacheState = {
      status: readResult.unavailable ? "unavailable" : "missing",
      hints: {
        prefixes_1: {},
        prefixes_2: {},
        postcode_samples_1: {},
        postcode_samples_2: {},
      },
    };
    return prefixHintsCacheState;
  }

  const payload = readResult.payload && typeof readResult.payload === "object" ? readResult.payload : {};
  const prefixes1 = payload.prefixes_1 && typeof payload.prefixes_1 === "object" ? payload.prefixes_1 : {};
  const prefixes2 = payload.prefixes_2 && typeof payload.prefixes_2 === "object" ? payload.prefixes_2 : {};
  const postcodeSamples1 = payload.postcode_samples_1 && typeof payload.postcode_samples_1 === "object"
    ? payload.postcode_samples_1
    : {};
  const postcodeSamples2 = payload.postcode_samples_2 && typeof payload.postcode_samples_2 === "object"
    ? payload.postcode_samples_2
    : {};

  prefixHintsCacheKey = cacheKey;
  prefixHintsCacheState = {
    status: "ok",
    hints: {
      prefixes_1: prefixes1,
      prefixes_2: prefixes2,
      postcode_samples_1: postcodeSamples1,
      postcode_samples_2: postcodeSamples2,
    },
  };
  return prefixHintsCacheState;
}

function lookupAreaTown(values, areaTownId) {
  if (!values || typeof values !== "object") {
    return { area_name: null, post_town: null };
  }

  const row = values[String(areaTownId)] || values[areaTownId];
  if (!Array.isArray(row) || row.length < 2) {
    return { area_name: null, post_town: null };
  }

  return {
    area_name: row[0] ?? null,
    post_town: row[1] ?? null,
  };
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

  const shard = getPostcodeAreaFromPrefix(postcodeNormalised);
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
  const shardLookup = await readExactShardFromR2(env, prefix, shard);
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

  const lookupRecord = getLookupRecordFromShard(shardLookup.postcodes, postcodeNormalised);
  if (!lookupRecord) {
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

  const areaTownIndex = await readAreaTownIndex(env, prefix);
  const areaTown = lookupAreaTown(areaTownIndex.values, lookupRecord.area_town_id);
  const formattedPostcode = formatPostcode(postcodeNormalised);
  const payload = {
    ok: true,
    postcode: formattedPostcode,
    postcode_normalised: postcodeNormalised,
    lat: lookupRecord.lat,
    lon: lookupRecord.lon,
    pcon_code: lookupRecord.pcon_code,
    la_code: lookupRecord.la_code,
    area_town_id: lookupRecord.area_town_id,
    area_name: areaTown.area_name,
    post_town: areaTown.post_town,
    label: buildPostcodeLabel(formattedPostcode, areaTown.area_name, areaTown.post_town),
    source: shardLookup.source || "ONSPD",
  };

  if (lookupRecord.area_town_id > 0 && areaTownIndex.status !== "ok") {
    payload.warning = "area_town_index_unavailable";
  }

  return jsonResponse(payload, 200, SUCCESS_CACHE_CONTROL);
}

export async function handlePostcodeSuggestRequest(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      { ok: false, error: "method_not_allowed", message: "Only GET is supported." },
      405,
      "no-store",
    );
  }

  const url = new URL(request.url);
  const queryRaw = String(url.searchParams.get("q") || "");
  const queryNormalised = normalizeSuggestQuery(queryRaw);
  if (queryNormalised === null) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_query",
        message: "Enter a valid UK postcode prefix.",
      },
      400,
      "no-store",
    );
  }

  const limit = parseSuggestLimit(url);
  if (!queryNormalised) {
    return jsonResponse(
      {
        ok: true,
        query: queryRaw,
        query_normalised: "",
        results: [],
      },
      200,
      SUCCESS_CACHE_CONTROL,
    );
  }

  const prefix = normalizePrefix(env?.UK_AQ_POSTCODE_R2_PREFIX || DEFAULT_POSTCODE_PREFIX);

  if (queryNormalised.length <= 2) {
    const hintsState = await readPrefixHints(env, prefix);
    if (hintsState.status === "unavailable") {
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

    const areaTownIndex = await readAreaTownIndex(env, prefix);
    const sampleList = queryNormalised.length === 1
      ? hintsState.hints.postcode_samples_1[queryNormalised]
      : hintsState.hints.postcode_samples_2[queryNormalised];
    const sampledPostcodes = Array.isArray(sampleList)
      ? sampleList
          .map((row) => parsePostcodeSampleRow(row))
          .filter((row) => row && row.postcode_normalised)
      : [];

    if (sampledPostcodes.length > 0) {
      const results = sampledPostcodes.slice(0, limit).map((row) => {
        const areaTown = lookupAreaTown(areaTownIndex.values, row.area_town_id);
        return {
          type: "postcode",
          postcode: row.postcode,
          postcode_normalised: row.postcode_normalised,
          area_town_id: row.area_town_id,
          area_name: areaTown.area_name,
          post_town: areaTown.post_town,
          label: buildPostcodeLabel(row.postcode, areaTown.area_name, areaTown.post_town),
        };
      });

      const payload = {
        ok: true,
        query: queryRaw,
        query_normalised: queryNormalised,
        source: "postcode_prefix_samples",
        results,
      };
      if (areaTownIndex.status !== "ok") {
        payload.warning = "area_town_index_unavailable";
      }
      return jsonResponse(payload, 200, SUCCESS_CACHE_CONTROL);
    }

    const hintList = queryNormalised.length === 1
      ? hintsState.hints.prefixes_1[queryNormalised]
      : hintsState.hints.prefixes_2[queryNormalised];

    const results = Array.isArray(hintList)
      ? hintList.slice(0, limit).map((item) => ({
        type: "postcode_hint",
        prefix: String(item?.prefix || "").toUpperCase(),
        label: String(item?.label || "").trim() || `${String(item?.prefix || "").toUpperCase()} postcodes`,
        count: Number(item?.count || 0),
      })).filter((item) => item.prefix)
      : [];

    return jsonResponse(
      {
        ok: true,
        query: queryRaw,
        query_normalised: queryNormalised,
        source: "postcode_prefix_hints",
        results,
      },
      200,
      SUCCESS_CACHE_CONTROL,
    );
  }

  const area = getPostcodeAreaFromPrefix(queryNormalised);
  if (!area) {
    return jsonResponse(
      {
        ok: true,
        query: queryRaw,
        query_normalised: queryNormalised,
        source: "postcode_suggest_shard",
        results: [],
      },
      200,
      SUCCESS_CACHE_CONTROL,
    );
  }

  const suggestShard = await readSuggestShardFromR2(env, prefix, area);
  if (!suggestShard.ok && suggestShard.unavailable) {
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
  if (!suggestShard.ok && suggestShard.missing) {
    return jsonResponse(
      {
        ok: true,
        query: queryRaw,
        query_normalised: queryNormalised,
        source: "postcode_suggest_shard",
        results: [],
      },
      200,
      SUCCESS_CACHE_CONTROL,
    );
  }

  const areaTownIndex = await readAreaTownIndex(env, prefix);
  const matches = [];
  for (const row of suggestShard.rows) {
    const postcodeNormalised = String(row[0] || "").trim().toUpperCase();
    if (!postcodeNormalised.startsWith(queryNormalised)) {
      continue;
    }

    const postcodeDisplay = String(row[1] || "").trim() || formatPostcode(postcodeNormalised);
    const areaTownId = parseAreaTownId(row[2]);
    const areaTown = lookupAreaTown(areaTownIndex.values, areaTownId);

    matches.push({
      rank: getSuggestMatchRank(queryNormalised, postcodeNormalised),
      postcode_normalised: postcodeNormalised,
      payload: {
      type: "postcode",
      postcode: postcodeDisplay,
      postcode_normalised: postcodeNormalised,
      area_town_id: areaTownId,
      area_name: areaTown.area_name,
      post_town: areaTown.post_town,
      label: buildPostcodeLabel(postcodeDisplay, areaTown.area_name, areaTown.post_town),
      },
    });
  }

  matches.sort((left, right) => {
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return left.postcode_normalised.localeCompare(right.postcode_normalised);
  });

  const results = matches.slice(0, limit).map((item) => item.payload);

  const payload = {
    ok: true,
    query: queryRaw,
    query_normalised: queryNormalised,
    source: "postcode_suggest_shard",
    results,
  };
  if (areaTownIndex.status !== "ok") {
    payload.warning = "area_town_index_unavailable";
  }

  return jsonResponse(payload, 200, SUCCESS_CACHE_CONTROL);
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

    if (SUGGEST_PATHS.has(pathname)) {
      return handlePostcodeSuggestRequest(request, env);
    }

    return handlePostcodeLookupRequest(request, env);
  },
};
