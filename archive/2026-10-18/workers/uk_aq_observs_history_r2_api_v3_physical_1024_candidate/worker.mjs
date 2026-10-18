import {
  createR2ObservationHistoryV3Source,
} from "../shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  ObservationHistoryPhysicalCandidateReadError,
  readObservationHistoryPhysicalCandidate,
} from "../uk_aq_observs_history_r2_api_v3_physical_candidate/reader.mjs";

const LOGICAL_HISTORY_VERSION = "v2";
const INDEX_GENERATION = "v3-physical-index-candidate";
const CANDIDATE_VERSION = "physical-index-v1";
const PHYSICAL_LAYOUT_VERSION = "timeseries-aligned-v2";
const WRITER_VERSION = "pyarrow-zstd-timeseries-aligned-candidate-v1";
const ALIGNED_ROW_CAP = 1024;
const DEFAULT_PROTOTYPE_PREFIX =
  "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/cap_rows=1024";
const ALIGNED_DATA_PREFIX =
  "history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=1024/observations";
const RESPONSE_CACHE_GENERATION = "physical-index-v1-1024-1";
const TIMESERIES_BINDING_CACHE_GENERATION = "3";
const DEFAULT_MUTABLE_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LIMIT = 20000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DEFAULT_BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const VALID_OBSERVATION_PATHS = new Set(["/", "/v1/observations"]);
export const PHYSICAL_CANDIDATE_DIAGNOSTIC_MODE = "workload_v1";

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
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_LIMIT ? number : null;
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

function jsonResponse(payload, { status = 200, cacheSeconds = 30, noStore = false, extraHeaders = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": noStore
        ? "no-store"
        : `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`,
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
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
  if (required(env.UKAQ_ENV_NAME).toUpperCase() !== "TEST") {
    throw new Error("Physical-index candidate requires UKAQ_ENV_NAME=TEST");
  }
  if (required(env.UK_AQ_R2_HISTORY_VERSION) !== LOGICAL_HISTORY_VERSION) {
    throw new Error("Physical-index candidate requires UK_AQ_R2_HISTORY_VERSION=v2");
  }
  if (required(env.UK_AQ_R2_HISTORY_INDEX_VERSION) !== INDEX_GENERATION) {
    throw new Error(`Physical-index candidate requires UK_AQ_R2_HISTORY_INDEX_VERSION=${INDEX_GENERATION}`);
  }
  const prefix = normalizePrefix(env.UK_AQ_PHYSICAL_INDEX_PROTOTYPE_PREFIX);
  if (
    prefix !== DEFAULT_PROTOTYPE_PREFIX ||
    /(?:history\/v2|_index_v3|_latest|backup|checkpoint|live)/i.test(prefix)
  ) throw new Error(`Physical-index candidate requires exact isolated prefix ${DEFAULT_PROTOTYPE_PREFIX}`);
  if (!env.UK_AQ_HISTORY_BUCKET) throw new Error("Missing UK_AQ_HISTORY_BUCKET R2 binding");
  return `${prefix}/observations_timeseries`;
}

export function parseObservationRequest(url) {
  if (!VALID_OBSERVATION_PATHS.has(url.pathname)) return { ok: false, status: 404, error: "Not found." };
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  const connectorId = positiveInteger(url.searchParams.get("connector_id"));
  const pollutantCode = normalizePollutant(url.searchParams.get("pollutant"));
  const startIso = isoOrNull(url.searchParams.get("start_utc"));
  const endIso = isoOrNull(url.searchParams.get("end_utc"));
  if (!timeseriesId) return { ok: false, status: 400, error: "timeseries_id must be a positive integer." };
  if (!connectorId) return { ok: false, status: 400, error: "connector_id must be a positive integer." };
  if (!pollutantCode) return { ok: false, status: 400, error: "pollutant must be one of pm25, pm10, or no2." };
  if (!startIso || !endIso) return { ok: false, status: 400, error: "start_utc and end_utc must be valid ISO timestamps." };
  if (Date.parse(endIso) <= Date.parse(startIso)) return { ok: false, status: 400, error: "end_utc must be greater than start_utc." };
  const sinceRequested = url.searchParams.has("since_utc");
  const sinceIso = sinceRequested ? isoOrNull(url.searchParams.get("since_utc")) : null;
  if (sinceRequested && !sinceIso) return { ok: false, status: 400, error: "since_utc must be a valid ISO timestamp when provided." };
  const limitRequested = url.searchParams.has("limit");
  const limit = optionalLimit(url.searchParams.get("limit"));
  if (limitRequested && limit === null) return { ok: false, status: 400, error: `limit must be an integer between 1 and ${MAX_LIMIT}.` };
  const diagnosticRequested = url.searchParams.has("diagnostics");
  const diagnosticMode = diagnosticRequested ? required(url.searchParams.get("diagnostics")) : null;
  if (diagnosticRequested && diagnosticMode !== PHYSICAL_CANDIDATE_DIAGNOSTIC_MODE) {
    return { ok: false, status: 400, error: `diagnostics must be ${PHYSICAL_CANDIDATE_DIAGNOSTIC_MODE} when provided.` };
  }
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso, sinceIso, limit, diagnosticMode };
}

function diagnosticRequestContext(request, params) {
  if (!params.diagnosticMode) return null;
  return {
    schema_version: 1,
    mode: params.diagnosticMode,
    request_id: globalThis.crypto.randomUUID(),
    cloudflare_ray_id: required(request.headers.get("cf-ray")) || null,
    started_at: globalThis.performance?.now?.() ?? Date.now(),
  };
}

function diagnosticPayload(context, details = {}) {
  if (!context) return null;
  const now = globalThis.performance?.now?.() ?? Date.now();
  return {
    schema_version: 1,
    mode: context.mode,
    request_id: context.request_id,
    cloudflare_ray_id: context.cloudflare_ray_id,
    cache_bypassed: true,
    timing_basis: "performance_now_deployed_workers_advances_only_after_io_not_cpu_time",
    cpu_time_ms: null,
    cpu_time_source: "cloudflare_invocation_logs_or_analytics",
    worker_pre_response_elapsed_ms: Number((now - context.started_at).toFixed(3)),
    ...details,
  };
}

function diagnosticHeaders(context) {
  return context ? { "x-ukaq-diagnostic-request-id": context.request_id } : {};
}

function parseBindingRequest(url) {
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  return timeseriesId ? { ok: true, timeseriesId } : { ok: false, status: 400, error: "timeseries_id must be a positive integer." };
}

function isValidBinding(binding, timeseriesId) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
  const pollutantCode = required(binding.pollutant_code);
  const valid = [1, 2].includes(binding.schema_version) && binding.history_version === "v2" &&
    binding.index_kind === "timeseries_binding" && positiveInteger(binding.timeseries_id) === timeseriesId &&
    positiveInteger(binding.connector_id) && positiveInteger(binding.station_id) && /^[a-z0-9_]+$/.test(pollutantCode);
  if (!valid) return false;
  if (binding.schema_version === 1) return binding.continuity === undefined;
  return Boolean(binding.continuity?.schema_version === 1 && Array.isArray(binding.continuity.members) &&
    binding.continuity.members.length >= 2 && binding.continuity.pollutant_code === pollutantCode &&
    binding.continuity.members.filter((member) => positiveInteger(member?.timeseries_id) === timeseriesId).length === 1);
}

function cachePolicy(endIso) {
  const immutable = Date.parse(endIso) <= Date.now() - MUTABLE_WINDOW_MS;
  return { scope: immutable ? "immutable" : "recent", seconds: immutable ? DEFAULT_IMMUTABLE_CACHE_SECONDS : DEFAULT_MUTABLE_CACHE_SECONDS };
}

function cacheKey(requestUrl, generation) {
  const url = new URL(requestUrl);
  url.searchParams.set("__ukaq_observs_history_read_v", generation);
  url.searchParams.set("__ukaq_observs_history_cache_gen", generation === INDEX_GENERATION ? RESPONSE_CACHE_GENERATION : TIMESERIES_BINDING_CACHE_GENERATION);
  url.searchParams.sort();
  return new Request(url.toString(), { method: "GET" });
}

function withCacheHeaders(response, marker, generation) {
  const headers = new Headers(response.headers);
  headers.set("x-ukaq-cache", marker);
  headers.set("x-ukaq-cache-generation", generation);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleBinding(params, env) {
  const prefix = normalizePrefix(env.UK_AQ_R2_HISTORY_V2_TIMESERIES_BINDING_INDEX_PREFIX || DEFAULT_BINDING_PREFIX);
  if (prefix !== DEFAULT_BINDING_PREFIX) throw new Error(`Candidate binding prefix must remain ${DEFAULT_BINDING_PREFIX}`);
  const key = `${prefix}/timeseries_id=${params.timeseriesId}.json`;
  const object = await env.UK_AQ_HISTORY_BUCKET.get(key);
  if (!object) return jsonResponse({ ok: false, error: "timeseries_binding_not_found", timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key }, { status: 404, noStore: true });
  const binding = await object.json().catch(() => null);
  if (!isValidBinding(binding, params.timeseriesId)) {
    return jsonResponse({ ok: false, error: "timeseries_binding_invalid", timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key }, { status: 422, noStore: true });
  }
  return jsonResponse({ ok: true, timeseries_id: params.timeseriesId, binding_index_prefix: prefix, binding_key: key, binding }, { cacheSeconds: DEFAULT_IMMUTABLE_CACHE_SECONDS });
}

async function handleObservations(params, env, diagnosticContext) {
  const indexRoot = assertCandidateConfiguration(env);
  const effectiveStartMs = params.sinceIso
    ? Math.max(Date.parse(params.startIso), Date.parse(params.sinceIso) + 1)
    : Date.parse(params.startIso);
  const result = await readObservationHistoryPhysicalCandidate({
    source: createR2ObservationHistoryV3Source({ bucket: env.UK_AQ_HISTORY_BUCKET }),
    timeseriesId: params.timeseriesId,
    connectorId: params.connectorId,
    pollutantCode: params.pollutantCode,
    startUtc: new Date(effectiveStartMs).toISOString(),
    endUtc: params.endIso,
    indexRoot,
    alignedRowCap: ALIGNED_ROW_CAP,
  });
  const allRows = result.rows.map((row) => ({ observed_at: row.observed_at_utc, value: row.value }));
  const limited = params.limit !== null && allRows.length > params.limit;
  const rows = limited ? allRows.slice(0, params.limit) : allRows;
  const partialReasons = [...new Set([...result.partial_reasons, ...(limited ? ["limited_by_limit"] : [])])];
  const complete = result.response_complete === true && !limited;
  const policy = cachePolicy(params.endIso);
  const diagnosticRequest = diagnosticPayload(diagnosticContext, {
    outcome: complete ? "complete" : "partial",
    rows_before_limit: allRows.length,
    rows_returned: rows.length,
    physical_index_candidate_version: CANDIDATE_VERSION,
  });
  if (diagnosticRequest) console.info(JSON.stringify({
    event: "observation_history_v3_physical_1024_candidate_workload_diagnostic_complete",
    diagnostic_request: diagnosticRequest,
    exact_reader_diagnostics: result.diagnostics,
  }));
  return jsonResponse({
    ok: true,
    generated_at_utc: new Date().toISOString(),
    read_version: LOGICAL_HISTORY_VERSION,
    index_version: INDEX_GENERATION,
    physical_index_candidate_version: CANDIDATE_VERSION,
    pollutant: params.pollutantCode,
    physical_layout_version: PHYSICAL_LAYOUT_VERSION,
    writer_version: WRITER_VERSION,
    aligned_row_cap: ALIGNED_ROW_CAP,
    history_prefix: ALIGNED_DATA_PREFIX,
    history_index_prefix: indexRoot,
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
    ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
    coverage: {
      read_version: LOGICAL_HISTORY_VERSION,
      index_version: INDEX_GENERATION,
      physical_index_candidate_version: CANDIDATE_VERSION,
      pollutant_partition: params.pollutantCode,
      physical_layout_version: PHYSICAL_LAYOUT_VERSION,
      writer_version: WRITER_VERSION,
      aligned_row_cap: ALIGNED_ROW_CAP,
      history_prefix: ALIGNED_DATA_PREFIX,
      history_index_prefix: indexRoot,
      timeseries_index_prefix: indexRoot,
      limited_by_limit: limited,
      total_rows_before_limit: allRows.length,
      response_complete: complete,
      has_gap: !complete,
      coverage_state: complete ? "complete" : "partial",
      partial_reasons: partialReasons,
      exact_reader_diagnostics: result.diagnostics,
    },
  }, { cacheSeconds: policy.seconds, noStore: !complete || Boolean(diagnosticContext), extraHeaders: diagnosticHeaders(diagnosticContext) });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET") return jsonResponse({ ok: false, error: "Method not allowed." }, { status: 405, noStore: true });
    const auth = authorize(request, env);
    if (!auth.ok) return jsonResponse({ ok: false, error: auth.error }, { status: auth.status, noStore: true });
    const url = new URL(request.url);
    let context = null;
    try {
      if (url.pathname === "/v1/timeseries-binding") {
        assertCandidateConfiguration(env);
        const params = parseBindingRequest(url);
        if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
        const key = cacheKey(request.url, "v2-binding");
        const cached = await caches.default.match(key);
        if (cached) return withCacheHeaders(cached, "HIT", TIMESERIES_BINDING_CACHE_GENERATION);
        const response = await handleBinding(params, env);
        if (response.ok) ctx?.waitUntil?.(caches.default.put(key, response.clone()));
        return withCacheHeaders(response, "MISS", TIMESERIES_BINDING_CACHE_GENERATION);
      }
      const params = parseObservationRequest(url);
      if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
      context = diagnosticRequestContext(request, params);
      if (context) {
        console.info(JSON.stringify({
          event: "observation_history_v3_physical_1024_candidate_workload_diagnostic_start",
          diagnostic_request_id: context.request_id,
          cloudflare_ray_id: context.cloudflare_ray_id,
          connector_id: params.connectorId,
          pollutant_code: params.pollutantCode,
          timeseries_id: params.timeseriesId,
          physical_index_candidate_version: CANDIDATE_VERSION,
          start_utc: params.startIso,
          end_utc: params.endIso,
        }));
        return withCacheHeaders(await handleObservations(params, env, context), "BYPASS", RESPONSE_CACHE_GENERATION);
      }
      const key = cacheKey(request.url, INDEX_GENERATION);
      const cached = await caches.default.match(key);
      if (cached) return withCacheHeaders(cached, "HIT", RESPONSE_CACHE_GENERATION);
      const response = await handleObservations(params, env, null);
      const payload = await response.clone().json().catch(() => null);
      if (response.ok && payload?.response_complete === true && payload?.has_gap !== true) {
        ctx?.waitUntil?.(caches.default.put(key, response.clone()));
      }
      return withCacheHeaders(response, "MISS", RESPONSE_CACHE_GENERATION);
    } catch (error) {
      const diagnostics = error instanceof ObservationHistoryPhysicalCandidateReadError ? error.diagnostics : null;
      const diagnosticRequest = diagnosticPayload(context, { outcome: "error" });
      console.warn(JSON.stringify({
        event: "observation_history_v3_physical_1024_candidate_error",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        diagnostics,
        ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
      }));
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(diagnostics ? { diagnostics } : {}),
        ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
      }, { status: 500, noStore: true, extraHeaders: diagnosticHeaders(context) });
    }
  },
};
