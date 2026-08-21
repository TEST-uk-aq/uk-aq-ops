import {
  OBSERVATION_HISTORY_V3_FOOTER_CACHE_GENERATION,
  OBSERVATION_HISTORY_V3_INDEX_ROOT,
  OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION,
  ObservationHistoryV3ReadError,
  createObservationHistoryV3FooterCache,
  readObservationHistoryExactV3,
} from "../shared/uk_aq_observation_history_reader_v3.mjs";
import {
  createR2ObservationHistoryV3Source,
} from "../shared/uk_aq_observation_history_random_access_v3.mjs";

const LOGICAL_HISTORY_VERSION = "v2";
const INDEX_GENERATION = "v3";
const TIMESERIES_BINDING_CACHE_GENERATION = "3";
const DEFAULT_MUTABLE_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 20000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DEFAULT_BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const VALID_OBSERVATION_PATHS = new Set(["/", "/v1/observations"]);
const footerCache = createObservationHistoryV3FooterCache();

function required(value) {
  return String(value ?? "").trim();
}

function normalizePrefix(value) {
  return required(value).replace(/^\/+|\/+$/g, "");
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function optionalLimit(value) {
  if (value === null || value === undefined || required(value) === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_LIMIT
    ? number
    : null;
}

function isoOrNull(value) {
  const text = required(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizePollutant(value) {
  const compact = required(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact === "pm25" || compact === "particulatematter25") return "pm25";
  if (compact === "pm10" || compact === "particulatematter10") return "pm10";
  if (compact === "no2" || compact === "nitrogendioxide") return "no2";
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-uk-aq-upstream-auth",
  };
}

function jsonResponse(payload, { status = 200, cacheSeconds = 30, noStore = false } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": noStore
        ? "no-store"
        : `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`,
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

function authorize(request, env) {
  const expected = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!expected) return { ok: false, status: 500, error: "Missing UK_AQ_EDGE_UPSTREAM_SECRET." };
  const supplied = required(request.headers.get(UPSTREAM_AUTH_HEADER));
  return supplied && timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, status: 401, error: "Unauthorized." };
}

function assertCandidateConfiguration(env) {
  if (required(env.UK_AQ_R2_HISTORY_VERSION).toLowerCase() !== LOGICAL_HISTORY_VERSION) {
    throw new Error("V3 candidate requires UK_AQ_R2_HISTORY_VERSION=v2");
  }
  if (required(env.UK_AQ_R2_HISTORY_INDEX_VERSION).toLowerCase() !== INDEX_GENERATION) {
    throw new Error("V3 candidate requires UK_AQ_R2_HISTORY_INDEX_VERSION=v3");
  }
  const indexRoot = normalizePrefix(env.UK_AQ_R2_HISTORY_V3_OBSERVATIONS_TIMESERIES_INDEX_PREFIX);
  if (indexRoot !== OBSERVATION_HISTORY_V3_INDEX_ROOT) {
    throw new Error(`V3 candidate requires index root ${OBSERVATION_HISTORY_V3_INDEX_ROOT}`);
  }
  if (!env.UK_AQ_HISTORY_BUCKET) throw new Error("Missing UK_AQ_HISTORY_BUCKET R2 binding");
  return indexRoot;
}

function parseObservationRequest(url) {
  if (!VALID_OBSERVATION_PATHS.has(url.pathname)) return { ok: false, status: 404, error: "Not found." };
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  if (!timeseriesId) return { ok: false, status: 400, error: "timeseries_id must be a positive integer." };
  const connectorId = positiveInteger(url.searchParams.get("connector_id"));
  if (!connectorId) return { ok: false, status: 400, error: "connector_id must be a positive integer." };
  const pollutantCode = normalizePollutant(url.searchParams.get("pollutant"));
  if (!pollutantCode) return { ok: false, status: 400, error: "pollutant must be one of pm25, pm10, or no2." };
  const startIso = isoOrNull(url.searchParams.get("start_utc"));
  const endIso = isoOrNull(url.searchParams.get("end_utc"));
  if (!startIso || !endIso) return { ok: false, status: 400, error: "start_utc and end_utc must be valid ISO timestamps." };
  if (Date.parse(endIso) <= Date.parse(startIso)) return { ok: false, status: 400, error: "end_utc must be greater than start_utc." };
  const sinceRequested = url.searchParams.has("since_utc");
  const sinceIso = sinceRequested ? isoOrNull(url.searchParams.get("since_utc")) : null;
  if (sinceRequested && !sinceIso) return { ok: false, status: 400, error: "since_utc must be a valid ISO timestamp when provided." };
  const limitRequested = url.searchParams.has("limit");
  const limit = optionalLimit(url.searchParams.get("limit"));
  if (limitRequested && limit === null) return { ok: false, status: 400, error: `limit must be an integer between 1 and ${MAX_LIMIT}.` };
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso, sinceIso, limit };
}

function parseBindingRequest(url) {
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  return timeseriesId
    ? { ok: true, timeseriesId }
    : { ok: false, status: 400, error: "timeseries_id must be a positive integer." };
}

function isValidTimeseriesBinding(binding, timeseriesId) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const connectorId = positiveInteger(binding.connector_id);
  const stationId = positiveInteger(binding.station_id);
  const pollutantCode = required(binding.pollutant_code);
  const baseValid = [1, 2].includes(binding.schema_version)
    && binding.history_version === "v2"
    && binding.index_kind === "timeseries_binding"
    && positiveInteger(binding.timeseries_id) === timeseriesId
    && connectorId !== null
    && stationId !== null
    && /^[a-z0-9_]+$/.test(pollutantCode);
  if (!baseValid) return false;
  if (binding.schema_version === 1) return binding.continuity === undefined;
  const continuity = binding.continuity;
  return Boolean(continuity && continuity.schema_version === 1
    && Array.isArray(continuity.members) && continuity.members.length >= 2
    && continuity.pollutant_code === pollutantCode
    && continuity.members.filter((member) => positiveInteger(member?.timeseries_id) === timeseriesId).length === 1);
}

function cachePolicy(endIso) {
  const immutable = Date.parse(endIso) <= Date.now() - MUTABLE_WINDOW_MS;
  return {
    scope: immutable ? "immutable" : "recent",
    seconds: immutable ? DEFAULT_IMMUTABLE_CACHE_SECONDS : DEFAULT_MUTABLE_CACHE_SECONDS,
  };
}

function cacheKey(requestUrl, params, generation) {
  const url = new URL(requestUrl);
  url.searchParams.set("__ukaq_observs_history_read_v", generation === INDEX_GENERATION ? "v3" : "v2");
  url.searchParams.set("__ukaq_observs_history_cache_gen", generation === INDEX_GENERATION
    ? OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION
    : TIMESERIES_BINDING_CACHE_GENERATION);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

function withCacheHeaders(response, marker, generation) {
  const headers = new Headers(response.headers);
  headers.set("x-ukaq-cache", marker);
  headers.set("x-ukaq-cache-generation", generation);
  if (generation === OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION) {
    headers.set("x-ukaq-footer-cache-generation", OBSERVATION_HISTORY_V3_FOOTER_CACHE_GENERATION);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleBinding(params, env) {
  const prefix = normalizePrefix(env.UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX || DEFAULT_BINDING_PREFIX);
  if (prefix !== DEFAULT_BINDING_PREFIX) throw new Error(`V3 candidate binding prefix must remain ${DEFAULT_BINDING_PREFIX}`);
  const key = `${prefix}/timeseries_id=${params.timeseriesId}.json`;
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) return jsonResponse({ ok: false, error: "timeseries_binding_not_found", timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key }, { status: 404, noStore: true });
  const binding = await object.json().catch(() => null);
  if (!isValidTimeseriesBinding(binding, params.timeseriesId)) {
    return jsonResponse({ ok: false, error: "timeseries_binding_invalid", timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key }, { status: 422, noStore: true });
  }
  return jsonResponse({ ok: true, timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key, binding }, { cacheSeconds: DEFAULT_IMMUTABLE_CACHE_SECONDS });
}

async function handleObservations(params, env) {
  const indexRoot = assertCandidateConfiguration(env);
  const effectiveStartMs = params.sinceIso
    ? Math.max(Date.parse(params.startIso), Date.parse(params.sinceIso) + 1)
    : Date.parse(params.startIso);
  const readStartIso = new Date(effectiveStartMs).toISOString();
  const result = await readObservationHistoryExactV3({
    source: createR2ObservationHistoryV3Source({ bucket: env.UK_AQ_HISTORY_BUCKET }),
    indexGeneration: INDEX_GENERATION,
    historyVersion: LOGICAL_HISTORY_VERSION,
    timeseriesId: params.timeseriesId,
    connectorId: params.connectorId,
    pollutantCode: params.pollutantCode,
    startUtc: readStartIso,
    endUtc: params.endIso,
    indexRoot,
    footerCache,
  });
  const allRows = result.rows.map((row) => ({ observed_at: row.observed_at_utc, value: row.value }));
  const limited = params.limit !== null && allRows.length > params.limit;
  const rows = limited ? allRows.slice(0, params.limit) : allRows;
  const partialReasons = [...new Set([...result.partial_reasons, ...(limited ? ["limited_by_limit"] : [])])];
  const complete = result.response_complete === true && !limited;
  const policy = cachePolicy(params.endIso);
  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    read_version: LOGICAL_HISTORY_VERSION,
    index_version: INDEX_GENERATION,
    pollutant: params.pollutantCode,
    history_prefix: "history/v2/observations",
    history_index_prefix: "history/_index_v3",
    timeseries_index_prefix: indexRoot,
    timeseries_id: params.timeseriesId,
    connector_id: params.connectorId,
    start_utc: params.startIso,
    end_utc: params.endIso,
    since_utc: params.sinceIso,
    cache_scope: policy.scope,
    row_count: rows.length,
    response_complete: complete,
    has_gap: !complete,
    coverage_state: complete ? "complete" : "partial",
    partial_reasons: partialReasons,
    rows,
    coverage: {
      read_version: LOGICAL_HISTORY_VERSION,
      index_version: INDEX_GENERATION,
      pollutant_partition: params.pollutantCode,
      history_prefix: "history/v2/observations",
      history_index_prefix: "history/_index_v3",
      timeseries_index_prefix: indexRoot,
      limited_by_limit: limited,
      total_rows_before_limit: allRows.length,
      response_complete: complete,
      has_gap: !complete,
      coverage_state: complete ? "complete" : "partial",
      partial_reasons: partialReasons,
      exact_reader_diagnostics: result.diagnostics,
    },
  }, { cacheSeconds: policy.seconds, noStore: !complete });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed." }, { status: 405, noStore: true });
    const auth = authorize(request, env);
    if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, { status: auth.status, noStore: true });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/v1/timeseries-binding") {
        assertCandidateConfiguration(env);
        const params = parseBindingRequest(url);
        if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
        const key = cacheKey(request.url, params, "v2-binding");
        const cached = await caches.default.match(key);
        if (cached) return withCacheHeaders(cached, "HIT", TIMESERIES_BINDING_CACHE_GENERATION);
        const response = await handleBinding(params, env);
        if (response.ok) ctx?.waitUntil?.(caches.default.put(key, response.clone()));
        return withCacheHeaders(response, "MISS", TIMESERIES_BINDING_CACHE_GENERATION);
      }
      const params = parseObservationRequest(url);
      if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
      const key = cacheKey(request.url, params, INDEX_GENERATION);
      const cached = await caches.default.match(key);
      if (cached) return withCacheHeaders(cached, "HIT", OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION);
      const response = await handleObservations(params, env);
      const payload = await response.clone().json().catch(() => null);
      if (response.ok && payload?.response_complete === true && payload?.has_gap !== true) {
        ctx?.waitUntil?.(caches.default.put(key, response.clone()));
      }
      return withCacheHeaders(response, "MISS", OBSERVATION_HISTORY_V3_RESPONSE_CACHE_GENERATION);
    } catch (error) {
      const diagnostics = error instanceof ObservationHistoryV3ReadError ? error.diagnostics : null;
      console.warn(JSON.stringify({ event: "observation_history_v3_candidate_error", path: url.pathname, error: error instanceof Error ? error.message : String(error), diagnostics }));
      return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error), ...(diagnostics ? { diagnostics } : {}) }, { status: 500, noStore: true });
    }
  },
};
