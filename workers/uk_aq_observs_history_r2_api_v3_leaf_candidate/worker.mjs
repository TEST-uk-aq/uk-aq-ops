import {
  createR2ObservationHistoryV3Source,
} from "../shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  OBSERVATION_HISTORY_EXACT_LEAF_LIMITS,
  ObservationHistoryExactLeafReadError,
  readObservationHistoryExactLeafPageV3,
} from "../shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";

const LOGICAL_HISTORY_VERSION = "v2";
const INDEX_GENERATION = "v3-physical-leaf-candidate";
const CANDIDATE_VERSION = "physical-leaf-index-v1";
const PHYSICAL_LAYOUT_VERSION = "timeseries-aligned-v2";
const WRITER_VERSION = "pyarrow-zstd-timeseries-aligned-candidate-v1";
const ALIGNED_ROW_CAP = 1024;
const DEFAULT_PROTOTYPE_PREFIX =
  "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024";
const ALIGNED_INDEX_PREFIX =
  "history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=1024/observations_timeseries";
const ALIGNED_DATA_PREFIX =
  "history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=1024/observations";
const RESPONSE_CACHE_GENERATION = "physical-leaf-index-v1-1024-page-4-production-shaped";
const TIMESERIES_BINDING_CACHE_GENERATION = "3";
const DEFAULT_MUTABLE_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DEFAULT_BINDING_PREFIX = "history/_index_v2/timeseries_binding";
const VALID_OBSERVATION_PATHS = new Set(["/", "/v1/observations"]);
export const PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE = "workload_v1";
export const PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE = "cpu_v1";
const PHYSICAL_CANDIDATE_DIAGNOSTIC_MODES = new Set([
  PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE,
  PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE,
]);

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
    throw new Error("Physical-leaf candidate requires UKAQ_ENV_NAME=TEST");
  }
  if (required(env.UK_AQ_R2_HISTORY_VERSION) !== LOGICAL_HISTORY_VERSION) {
    throw new Error("Physical-leaf candidate requires UK_AQ_R2_HISTORY_VERSION=v2");
  }
  if (required(env.UK_AQ_R2_HISTORY_INDEX_VERSION) !== INDEX_GENERATION) {
    throw new Error(`Physical-leaf candidate requires UK_AQ_R2_HISTORY_INDEX_VERSION=${INDEX_GENERATION}`);
  }
  const prefix = normalizePrefix(env.UK_AQ_PHYSICAL_INDEX_PROTOTYPE_PREFIX);
  if (
    prefix !== DEFAULT_PROTOTYPE_PREFIX ||
    /(?:history\/v2|_index_v3|_latest|backup|checkpoint|live)/i.test(prefix)
  ) throw new Error(`Physical-leaf candidate requires exact isolated prefix ${DEFAULT_PROTOTYPE_PREFIX}`);
  if (!env.UK_AQ_HISTORY_BUCKET) throw new Error("Missing UK_AQ_HISTORY_BUCKET R2 binding");
  return `${prefix}/observations_timeseries`;
}

export function physicalLeafCandidateReaderIndex(indexRoot) {
  return Object.freeze({
    root: indexRoot,
    alignedIndexRoot: ALIGNED_INDEX_PREFIX,
    alignedDataRoot: ALIGNED_DATA_PREFIX,
    indexGeneration: INDEX_GENERATION,
    historyVersion: LOGICAL_HISTORY_VERSION,
    historySchemaVersion: 3,
    writerVersion: WRITER_VERSION,
    physicalLayoutVersion: PHYSICAL_LAYOUT_VERSION,
    alignedRowCap: ALIGNED_ROW_CAP,
    decodeProfileId: "hyparquet-direct-column-v1",
    manifestKind: "observation_timeseries_physical_leaf_scoped_manifest",
    leafKind: "observation_timeseries_physical_leaf",
    additionalCommonFields: Object.freeze({
      physical_leaf_candidate_version: CANDIDATE_VERSION,
    }),
  });
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
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (endMs <= startMs) return { ok: false, status: 400, error_code: "logical_range_invalid", error: "end_utc must be greater than start_utc." };
  if (endMs - startMs > OBSERVATION_HISTORY_EXACT_LEAF_LIMITS.max_logical_request_ms) {
    return { ok: false, status: 400, error_code: "logical_range_exceeds_24_hours", error: "logical observation-history range must not exceed 24 hours." };
  }
  if (url.searchParams.has("since_utc")) {
    return { ok: false, status: 400, error_code: "since_utc_incompatible_with_physical_paging", error: "since_utc is not supported with exact physical-segment paging; use physical_cursor." };
  }
  if (url.searchParams.has("limit")) {
    return { ok: false, status: 400, error_code: "limit_incompatible_with_physical_paging", error: "limit is not supported with exact physical-segment paging." };
  }
  const physicalCursor = url.searchParams.has("physical_cursor")
    ? required(url.searchParams.get("physical_cursor"))
    : null;
  if (url.searchParams.has("physical_cursor") && !physicalCursor) {
    return { ok: false, status: 400, error_code: "physical_cursor_invalid", error: "physical_cursor must not be empty." };
  }
  const diagnosticRequested = url.searchParams.has("diagnostics");
  const diagnosticMode = diagnosticRequested ? required(url.searchParams.get("diagnostics")) : null;
  if (diagnosticRequested && !PHYSICAL_CANDIDATE_DIAGNOSTIC_MODES.has(diagnosticMode)) {
    return {
      ok: false,
      status: 400,
      error: `diagnostics must be ${[...PHYSICAL_CANDIDATE_DIAGNOSTIC_MODES].join(" or ")} when provided.`,
    };
  }
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso, physicalCursor, diagnosticMode };
}

function diagnosticRequestContext(request, params) {
  if (!params.diagnosticMode) return null;
  return {
    schema_version: 1,
    mode: params.diagnosticMode,
    request_id: globalThis.crypto.randomUUID(),
    cloudflare_ray_id: required(request.headers.get("cf-ray")) || null,
  };
}

function diagnosticPayload(context, details = {}) {
  if (!context) return null;
  return {
    schema_version: 1,
    mode: context.mode,
    request_id: context.request_id,
    cloudflare_ray_id: context.cloudflare_ray_id,
    cache_bypassed: true,
    cpu_time_ms: null,
    cpu_time_source: "cloudflare_invocation_logs_or_analytics",
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

function compactReaderSummary({ result, outcome, returnedRows }) {
  const diagnostics = result.diagnostics;
  return Object.freeze({
    schema_version: 1,
    outcome,
    page_number: result.physical_page.page_number,
    physical_page_path: result.physical_page.physical_page_path,
    continuation_supplied: result.physical_page.continuation_cursor_supplied,
    pagination_complete: result.physical_page.pagination_complete,
    physical_segments_decoded: result.physical_page.segments_decoded,
    physical_rows_decoded: result.physical_page.physical_rows_decoded,
    returned_rows: returnedRows,
    scoped_manifests_read: diagnostics.scoped_manifests_read,
    leaf_objects_read: diagnostics.timeseries_leaf_objects_read,
    index_objects_read: diagnostics.index_objects_read,
    index_bytes_read: diagnostics.index_bytes_read,
    whole_logical_range_discovery: diagnostics.whole_logical_range_segment_discovery,
    global_segment_sorting: diagnostics.global_segment_sorting,
    identity_head_reads: diagnostics.identity_head_reads,
    r2_range_reads: diagnostics.r2_range_reads,
    r2_bytes_requested: diagnostics.r2_bytes_requested,
    parquet_footer_fetched: diagnostics.parquet_footer_fetched,
    parquet_footer_parsed: diagnostics.parquet_footer_parsed,
    timeseries_id_decoded: diagnostics.timeseries_id_decoded,
  });
}

function compactErrorSummary(diagnostics) {
  return Object.freeze({
    schema_version: 1,
    outcome: "error",
    page_number: diagnostics?.physical_page_number ?? null,
    physical_page_path: diagnostics?.physical_page_path ?? null,
    continuation_supplied: diagnostics?.continuation_cursor_supplied ?? null,
    pagination_complete: diagnostics?.pagination_complete ?? null,
    physical_segments_decoded: diagnostics?.physical_segments_decoded ?? null,
    physical_rows_decoded: diagnostics?.physical_rows_decoded ?? null,
    returned_rows: diagnostics?.returned_rows ?? null,
    scoped_manifests_read: diagnostics?.scoped_manifests_read ?? null,
    leaf_objects_read: diagnostics?.timeseries_leaf_objects_read ?? null,
    index_objects_read: diagnostics?.index_objects_read ?? null,
    index_bytes_read: diagnostics?.index_bytes_read ?? null,
    whole_logical_range_discovery: diagnostics?.whole_logical_range_segment_discovery ?? null,
    global_segment_sorting: diagnostics?.global_segment_sorting ?? null,
    identity_head_reads: diagnostics?.identity_head_reads ?? null,
    r2_range_reads: diagnostics?.r2_range_reads ?? null,
    r2_bytes_requested: diagnostics?.r2_bytes_requested ?? null,
    parquet_footer_fetched: diagnostics?.parquet_footer_fetched ?? false,
    parquet_footer_parsed: diagnostics?.parquet_footer_parsed ?? false,
    timeseries_id_decoded: diagnostics?.timeseries_id_decoded ?? false,
  });
}

async function handleObservations(params, env, diagnosticContext) {
  const indexRoot = assertCandidateConfiguration(env);
  const result = await readObservationHistoryExactLeafPageV3({
    source: createR2ObservationHistoryV3Source({ bucket: env.UK_AQ_HISTORY_BUCKET }),
    timeseriesId: params.timeseriesId,
    connectorId: params.connectorId,
    pollutantCode: params.pollutantCode,
    startUtc: params.startIso,
    endUtc: params.endIso,
    physicalCursor: params.physicalCursor,
    index: physicalLeafCandidateReaderIndex(indexRoot),
  });
  const rows = result.rows.map((row) => ({ observed_at: row.observed_at_utc, value: row.value }));
  const partialReasons = result.partial_reasons;
  const complete = result.response_complete === true;
  const hasGap = result.has_gap === true;
  const policy = cachePolicy(params.endIso);
  const outcome = complete ? "complete" : (hasGap ? "partial_coverage" : "physical_page_more");
  const structuralSummary = compactReaderSummary({
    result,
    outcome,
    returnedRows: rows.length,
  });
  const diagnosticRequest = diagnosticPayload(diagnosticContext);
  if (diagnosticContext?.mode === PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE) {
    console.info(JSON.stringify({
      event: "observation_history_v3_physical_leaf_candidate_workload_diagnostic_complete",
      diagnostic_request_id: diagnosticContext.request_id,
      cloudflare_ray_id: diagnosticContext.cloudflare_ray_id,
      ...structuralSummary,
    }));
  } else if (diagnosticContext?.mode === PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE) {
    console.info(JSON.stringify({
      event: "observation_history_v3_physical_leaf_candidate_cpu_measurement",
      diagnostic_request_id: diagnosticContext.request_id,
      cloudflare_ray_id: diagnosticContext.cloudflare_ray_id,
      ...structuralSummary,
    }));
  }
  const payload = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    read_version: LOGICAL_HISTORY_VERSION,
    index_version: INDEX_GENERATION,
    physical_leaf_candidate_version: CANDIDATE_VERSION,
    pollutant: params.pollutantCode,
    physical_layout_version: PHYSICAL_LAYOUT_VERSION,
    writer_version: WRITER_VERSION,
    aligned_row_cap: ALIGNED_ROW_CAP,
    timeseries_id: params.timeseriesId,
    connector_id: params.connectorId,
    start_utc: params.startIso,
    end_utc: params.endIso,
    since_utc: null,
    cache_scope: policy.scope,
    row_count: rows.length,
    response_complete: complete,
    has_gap: hasGap,
    coverage_state: result.coverage_complete ? "complete" : "partial",
    partial_reasons: partialReasons,
    coverage_partial_reasons: result.coverage_partial_reasons,
    physical_page: result.physical_page,
    rows,
    ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
    ...(diagnosticContext?.mode === PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE
      ? { coverage: { exact_reader_diagnostics: result.diagnostics } }
      : {}),
    ...(diagnosticContext?.mode === PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE
      ? { cpu_measurement: structuralSummary }
      : {}),
  };
  return jsonResponse(payload, {
    cacheSeconds: policy.seconds,
    noStore: !complete || Boolean(diagnosticContext),
    extraHeaders: diagnosticHeaders(diagnosticContext),
  });
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
      if (!params.ok) return jsonResponse({ ok: false, ...(params.error_code ? { error_code: params.error_code } : {}), error: params.error }, { status: params.status, noStore: true });
      context = diagnosticRequestContext(request, params);
      if (context) {
        if (context.mode === PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE) {
          console.info(JSON.stringify({
            event: "observation_history_v3_physical_leaf_candidate_workload_diagnostic_start",
            diagnostic_request_id: context.request_id,
            cloudflare_ray_id: context.cloudflare_ray_id,
            connector_id: params.connectorId,
            pollutant_code: params.pollutantCode,
            timeseries_id: params.timeseriesId,
            physical_leaf_candidate_version: CANDIDATE_VERSION,
            start_utc: params.startIso,
            end_utc: params.endIso,
            physical_cursor_supplied: Boolean(params.physicalCursor),
          }));
        }
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
      const diagnostics = error instanceof ObservationHistoryExactLeafReadError ? error.diagnostics : null;
      const errorCode = error instanceof ObservationHistoryExactLeafReadError ? error.code : null;
      const status = errorCode === "physical_cursor_invalid" ||
        errorCode === "logical_range_invalid" ||
        errorCode === "logical_range_exceeds_24_hours"
        ? 400
        : 500;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const responseError = context?.mode === PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE
        ? (errorCode || "physical_leaf_cpu_measurement_failed")
        : errorMessage;
      const diagnosticRequest = diagnosticPayload(context, { outcome: "error" });
      const compactError = compactErrorSummary(diagnostics);
      if (context?.mode === PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE) {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_candidate_cpu_measurement",
          diagnostic_request_id: context.request_id,
          cloudflare_ray_id: context.cloudflare_ray_id,
          ...(errorCode ? { error_code: errorCode } : {}),
          ...compactError,
        }));
      } else if (context?.mode === PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE) {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_candidate_workload_diagnostic_error",
          diagnostic_request_id: context.request_id,
          cloudflare_ray_id: context.cloudflare_ray_id,
          ...(errorCode ? { error_code: errorCode } : {}),
          ...compactError,
        }));
      } else {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_candidate_error",
          path: url.pathname,
          error: errorMessage,
          ...(errorCode ? { error_code: errorCode } : {}),
          diagnostics,
        }));
      }
      return jsonResponse({
        ok: false,
        ...(errorCode ? { error_code: errorCode } : {}),
        error: responseError,
        ...(context?.mode === PHYSICAL_CANDIDATE_WORKLOAD_DIAGNOSTIC_MODE && diagnostics
          ? { diagnostics }
          : {}),
        ...(context?.mode === PHYSICAL_CANDIDATE_CPU_DIAGNOSTIC_MODE
          ? { cpu_measurement: compactError }
          : {}),
        ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
      }, { status, noStore: true, extraHeaders: diagnosticHeaders(context) });
    }
  },
};
