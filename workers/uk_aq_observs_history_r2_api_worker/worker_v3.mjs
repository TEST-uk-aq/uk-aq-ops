import { resolveObservationHistoryGeneration, getObservationHistoryGeneration } from "../shared/uk_aq_observation_history_generation.mjs";
import {
  createR2ObservationHistoryV3Source,
} from "../shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  OBSERVATION_HISTORY_EXACT_LEAF_LIMITS,
  ObservationHistoryExactLeafReadError,
  readObservationHistoryExactLeafDailyMetadataV3,
  readObservationHistoryExactLeafPageV3,
} from "../shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";
import {
  OBSERVATION_VERIFICATION_PER_OBSERVATION_MODEL,
  loadObservationVerificationAuthority,
  loadObservationVerificationDiscovery,
  observationVerificationManifestIdentityForConnector,
  resolveEffectiveObservationVerificationStatus,
} from "../shared/uk_aq_observation_verification_overlay.mjs";

const LOGICAL_HISTORY_VERSION = "v2";
const INDEX_GENERATION = "v3";
const PHYSICAL_LAYOUT_VERSION = "timeseries-aligned-v2";
const ALIGNED_ROW_CAP = 1024;
const V3 = getObservationHistoryGeneration("v3");
const ALIGNED_INDEX_PREFIX = `${V3.observations_timeseries_index_prefix}/_aligned`;
const ALIGNED_DATA_PREFIX = V3.observations_prefix;
const RESPONSE_CACHE_GENERATION = "side-by-side-v3-exact-leaf-3";
const TIMESERIES_BINDING_CACHE_GENERATION = "3";
const DEFAULT_MUTABLE_CACHE_SECONDS = 300;
const DEFAULT_IMMUTABLE_CACHE_SECONDS = 86400;
const MUTABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";
const DEFAULT_BINDING_PREFIX = V3.timeseries_binding_index_prefix;
const DAILY_PROVENANCE_PATH = "/v1/daily-validation-provenance";
const VALID_OBSERVATION_PATHS = new Set(["/", "/v1/observations"]);
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PROVENANCE_RANGE_MS = 366 * UTC_DAY_MS;
const MAX_PROVENANCE_PARTIAL_BOUNDARY_DAYS = 2;
const MAX_PROVENANCE_PARTIAL_PHYSICAL_PAGES = 16;
const PROVENANCE_PAGE_BUDGET_REASON =
  "observation_history_physical_page_budget_exceeded";
export const EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE = "workload_v1";
export const EXACT_HISTORY_CPU_DIAGNOSTIC_MODE = "cpu_v1";
const EXACT_HISTORY_DIAGNOSTIC_MODES = new Set([
  EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE,
  EXACT_HISTORY_CPU_DIAGNOSTIC_MODE,
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
  if (compact === "bc" || compact === "blackcarbon") return "bc";
  if (compact === "uv370" || compact === "uv370nm" || compact === "uvparticulatematter370nm") return "uv370";
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

function assertGenerationConfiguration(env) {
  if (resolveObservationHistoryGeneration(env) !== V3) throw new Error("Exact history requires generation v3");
  if (!env.UK_AQ_HISTORY_BUCKET) throw new Error("Missing UK_AQ_HISTORY_BUCKET");
  return V3.observations_timeseries_index_prefix;
}

export function observationHistoryV3ReaderIndex(indexRoot) {
  return Object.freeze({
    root: indexRoot,
    alignedIndexRoot: ALIGNED_INDEX_PREFIX,
    alignedDataRoot: ALIGNED_DATA_PREFIX,
    indexGeneration: INDEX_GENERATION,
    historyVersion: LOGICAL_HISTORY_VERSION,
    physicalLayoutVersion: PHYSICAL_LAYOUT_VERSION,
    alignedRowCap: ALIGNED_ROW_CAP,
    decodeProfileId: "hyparquet-direct-column-v1",
    manifestKind: "observation_timeseries_physical_leaf_scoped_manifest",
    leafKind: "observation_timeseries_physical_leaf",
    additionalCommonFields: Object.freeze({ exact_leaf_index_version: "exact-timeseries-leaf-v1" }),
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
  if (!pollutantCode) return { ok: false, status: 400, error: "pollutant must be one of pm25, pm10, no2, bc, or uv370." };
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
  if (diagnosticRequested && !EXACT_HISTORY_DIAGNOSTIC_MODES.has(diagnosticMode)) {
    return {
      ok: false,
      status: 400,
      error: `diagnostics must be ${[...EXACT_HISTORY_DIAGNOSTIC_MODES].join(" or ")} when provided.`,
    };
  }
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso, physicalCursor, diagnosticMode };
}


export function parseDailyProvenanceRequest(url) {
  if (url.pathname !== DAILY_PROVENANCE_PATH) {
    return { ok: false, status: 404, error: "Not found." };
  }
  const timeseriesId = positiveInteger(url.searchParams.get("timeseries_id"));
  const connectorId = positiveInteger(url.searchParams.get("connector_id"));
  const pollutantCode = normalizePollutant(url.searchParams.get("pollutant"));
  const startIso = isoOrNull(url.searchParams.get("start_utc"));
  const endIso = isoOrNull(url.searchParams.get("end_utc"));
  if (!timeseriesId || connectorId !== 1 || !pollutantCode || !startIso || !endIso) {
    return { ok: false, status: 400, error: "daily provenance requires one timeseries, connector_id=1, pollutant and UTC range." };
  }
  const duration = Date.parse(endIso) - Date.parse(startIso);
  if (duration <= 0 || duration > MAX_PROVENANCE_RANGE_MS) {
    return { ok: false, status: 400, error: "daily provenance range must be greater than zero and no more than 366 days." };
  }
  for (const key of url.searchParams.keys()) {
    if (!["timeseries_id", "connector_id", "pollutant", "start_utc", "end_utc"].includes(key)) {
      return { ok: false, status: 400, error: `unsupported daily provenance parameter: ${key}.` };
    }
  }
  return { ok: true, timeseriesId, connectorId, pollutantCode, startIso, endIso };
}

export function dailyProvenanceUtcDayIntersections({ startUtc, endUtc }) {
  const startIso = isoOrNull(startUtc);
  const endIso = isoOrNull(endUtc);
  if (!startIso || !endIso || startIso >= endIso) {
    throw new Error("daily provenance interval is invalid");
  }
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const intersections = [];
  for (
    let dayStartMs = Math.floor(startMs / UTC_DAY_MS) * UTC_DAY_MS;
    dayStartMs < endMs;
    dayStartMs += UTC_DAY_MS
  ) {
    const dayEndMs = dayStartMs + UTC_DAY_MS;
    const effectiveStartMs = Math.max(startMs, dayStartMs);
    const effectiveEndMs = Math.min(endMs, dayEndMs);
    intersections.push(Object.freeze({
      day_utc: new Date(dayStartMs).toISOString().slice(0, 10),
      effective_start_utc: new Date(effectiveStartMs).toISOString(),
      effective_end_utc: new Date(effectiveEndMs).toISOString(),
      is_complete_utc_day:
        effectiveStartMs === dayStartMs && effectiveEndMs === dayEndMs,
    }));
  }
  const partialCount = intersections.filter((day) => !day.is_complete_utc_day).length;
  if (partialCount > MAX_PROVENANCE_PARTIAL_BOUNDARY_DAYS) {
    throw new Error("daily provenance interval has too many partial UTC boundary days");
  }
  return Object.freeze(intersections);
}

function incompleteDailyProvenanceResponse(partialReasons, { hasGap = true } = {}) {
  return jsonResponse({
    ok: false,
    error_code: "observation_provenance_incomplete",
    error: "observation provenance is incomplete",
    response_complete: false,
    has_gap: hasGap,
    partial_reasons: [...new Set(partialReasons)],
  }, { status: 502, noStore: true });
}

function aurnVerificationTimeseries(authority, timeseriesId) {
  if (!authority?.overlay_authoritative || authority.connector_id !== 1) {
    throw new Error("authoritative connector-1 verification overlay is required");
  }
  const timeseries = authority.manifest?.timeseries?.find((entry) =>
    entry.timeseries_id === timeseriesId);
  if (!timeseries) throw new Error("verification overlay does not contain the requested timeseries");
  if (timeseries.source_verification_model !== OBSERVATION_VERIFICATION_PER_OBSERVATION_MODEL) {
    throw new Error("AURN daily provenance requires per-observation verification authority");
  }
  return timeseries;
}

export function deriveAurnPartialDayValidationStatus({ authority, timeseriesId, rows }) {
  aurnVerificationTimeseries(authority, timeseriesId);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let sawRatified = false;
  for (const row of rows) {
    const status = resolveEffectiveObservationVerificationStatus({
      authority,
      timeseriesId,
      observedAtUtc: row?.observed_at_utc,
      legacyStatus: null,
    });
    if (status === "P") return "P";
    if (status !== "R") {
      throw new Error("verification overlay cannot classify a boundary-day observation");
    }
    sawRatified = true;
  }
  return sawRatified ? "R" : null;
}

async function readPartialDailyProvenance({
  source,
  index,
  params,
  intersection,
  verificationAuthority,
  pageBudget,
}) {
  const rows = [];
  let physicalCursor = null;
  while (true) {
    if (pageBudget.pages >= MAX_PROVENANCE_PARTIAL_PHYSICAL_PAGES) {
      return {
        complete: false,
        has_gap: false,
        partial_reasons: [PROVENANCE_PAGE_BUDGET_REASON],
      };
    }
    let result;
    try {
      result = await readObservationHistoryExactLeafPageV3({
        source,
        timeseriesId: params.timeseriesId,
        connectorId: params.connectorId,
        pollutantCode: params.pollutantCode,
        startUtc: intersection.effective_start_utc,
        endUtc: intersection.effective_end_utc,
        physicalCursor,
        index,
      });
    } catch (error) {
      if (physicalCursor && error instanceof ObservationHistoryExactLeafReadError) {
        return {
          complete: false,
          has_gap: true,
          partial_reasons: ["required_physical_leaf_continuation_invalid"],
        };
      }
      throw error;
    }
    pageBudget.pages += 1;
    if (result.has_gap === true || result.coverage_complete !== true) {
      return {
        complete: false,
        has_gap: true,
        partial_reasons: result.coverage_partial_reasons?.length
          ? result.coverage_partial_reasons
          : ["required_physical_leaf_coverage_incomplete"],
      };
    }
    rows.push(...result.rows);
    if (result.response_complete === true) break;
    const nextCursor = result.physical_page?.next_cursor;
    if (
      result.physical_page?.pagination_complete !== false ||
      typeof nextCursor !== "string" ||
      !nextCursor ||
      nextCursor === physicalCursor
    ) {
      throw new Error("partial-day exact-leaf cursor progression is contradictory");
    }
    physicalCursor = nextCursor;
  }
  return {
    complete: true,
    status: deriveAurnPartialDayValidationStatus({
      authority: verificationAuthority,
      timeseriesId: params.timeseriesId,
      rows,
    }),
  };
}

async function handleDailyProvenance(params, env) {
  const verificationAuthority = await loadObservationVerificationAuthority({
    bucket: env.UK_AQ_HISTORY_BUCKET,
    connectorId: params.connectorId,
    cache: caches.default,
  });
  if (!verificationAuthority.overlay_authoritative) {
    return jsonResponse({
      ok: false,
      error_code: "verification_overlay_not_authoritative",
      error: "verification_overlay_not_authoritative",
    }, { status: 503, noStore: true });
  }
  const source = createR2ObservationHistoryV3Source({ bucket: env.UK_AQ_HISTORY_BUCKET });
  const index = observationHistoryV3ReaderIndex(V3.observations_timeseries_index_prefix);
  const intersections = dailyProvenanceUtcDayIntersections({
    startUtc: params.startIso,
    endUtc: params.endIso,
  });
  const daily = new Map();
  const completeDays = intersections.filter((day) => day.is_complete_utc_day);
  if (completeDays.length > 0) {
    const result = await readObservationHistoryExactLeafDailyMetadataV3({
      source,
      timeseriesId: params.timeseriesId,
      connectorId: params.connectorId,
      pollutantCode: params.pollutantCode,
      startUtc: completeDays[0].effective_start_utc,
      endUtc: completeDays.at(-1).effective_end_utc,
      index,
    });
    if (result.response_complete !== true || result.has_gap === true) {
      return incompleteDailyProvenanceResponse(result.partial_reasons);
    }
    for (const row of result.rows) {
      daily.set(row.day_utc, deriveAurnDailyValidationStatus({
        authority: verificationAuthority,
        timeseriesId: params.timeseriesId,
        minObservedAtUtc: row.min_observed_at_utc,
        maxObservedAtUtc: row.max_observed_at_utc,
      }));
    }
  }

  const pageBudget = { pages: 0 };
  for (const intersection of intersections.filter((day) => !day.is_complete_utc_day)) {
    const result = await readPartialDailyProvenance({
      source,
      index,
      params,
      intersection,
      verificationAuthority,
      pageBudget,
    });
    if (!result.complete) {
      return incompleteDailyProvenanceResponse(result.partial_reasons, {
        hasGap: result.has_gap,
      });
    }
    if (result.status !== null) daily.set(intersection.day_utc, result.status);
  }
  return jsonResponse({
    ok: true, timeseries_id: params.timeseriesId, connector_id: 1,
    pollutant: params.pollutantCode, start_utc: params.startIso, end_utc: params.endIso,
    response_complete: true, has_gap: false,
    rows: [...daily].sort(([left], [right]) => left.localeCompare(right))
      .map(([day_utc, source_validation_status]) => ({
        day_utc,
        source_validation_status,
      })),
  }, { noStore: true });
}

export function deriveAurnDailyValidationStatus({
  authority,
  timeseriesId,
  minObservedAtUtc,
  maxObservedAtUtc,
}) {
  const timeseries = aurnVerificationTimeseries(authority, timeseriesId);
  const minObserved = isoOrNull(minObservedAtUtc);
  const maxObserved = isoOrNull(maxObservedAtUtc);
  if (!minObserved || !maxObserved || minObserved > maxObserved) {
    throw new Error("exact-leaf daily observation bounds are invalid");
  }
  const atMinimum = resolveEffectiveObservationVerificationStatus({
    authority,
    timeseriesId,
    observedAtUtc: minObserved,
    legacyStatus: null,
  });
  if (atMinimum === "P") return "P";
  if (atMinimum !== "R") {
    throw new Error("verification overlay cannot classify the first daily observation");
  }
  return timeseries.periods.some((period) =>
    period.status === "P" &&
    period.from_observed_at_utc !== null &&
    period.from_observed_at_utc > minObserved &&
    period.from_observed_at_utc <= maxObserved
  ) ? "P" : "R";
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

function cacheKey(requestUrl, generation, verificationIdentity = null) {
  const url = new URL(requestUrl);
  url.searchParams.set("__ukaq_observs_history_read_v", generation);
  url.searchParams.set("__ukaq_observs_history_cache_gen", generation === INDEX_GENERATION ? RESPONSE_CACHE_GENERATION : TIMESERIES_BINDING_CACHE_GENERATION);
  if (verificationIdentity) {
    url.searchParams.set("__ukaq_verification_identity", verificationIdentity);
  }
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
  const prefix = V3.timeseries_binding_index_prefix;
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
    physical_schemas: result.physical_schemas,
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

async function handleObservations(
  params,
  env,
  diagnosticContext,
  verificationAuthority,
) {
  const indexRoot = assertGenerationConfiguration(env);
  const result = await readObservationHistoryExactLeafPageV3({
    source: createR2ObservationHistoryV3Source({ bucket: env.UK_AQ_HISTORY_BUCKET }),
    timeseriesId: params.timeseriesId,
    connectorId: params.connectorId,
    pollutantCode: params.pollutantCode,
    startUtc: params.startIso,
    endUtc: params.endIso,
    physicalCursor: params.physicalCursor,
    index: observationHistoryV3ReaderIndex(indexRoot),
  });
  const rows = result.rows.map((row) => ({
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: resolveEffectiveObservationVerificationStatus({
      authority: verificationAuthority,
      timeseriesId: params.timeseriesId,
      observedAtUtc: row.observed_at_utc,
      legacyStatus: row.verification_status,
    }),
  }));
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
  if (diagnosticContext?.mode === EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE) {
    console.info(JSON.stringify({
      event: "observation_history_v3_physical_leaf_workload_diagnostic_complete",
      diagnostic_request_id: diagnosticContext.request_id,
      cloudflare_ray_id: diagnosticContext.cloudflare_ray_id,
      ...structuralSummary,
    }));
  } else if (diagnosticContext?.mode === EXACT_HISTORY_CPU_DIAGNOSTIC_MODE) {
    console.info(JSON.stringify({
      event: "observation_history_v3_physical_leaf_cpu_measurement",
      diagnostic_request_id: diagnosticContext.request_id,
      cloudflare_ray_id: diagnosticContext.cloudflare_ray_id,
      ...structuralSummary,
    }));
  }
  const payload = {
    ok: true,
    generated_at_utc: new Date().toISOString(),
    read_version: "v3",
    index_version: INDEX_GENERATION,
    pollutant: params.pollutantCode,
    physical_layout_version: PHYSICAL_LAYOUT_VERSION,
    aligned_row_cap: ALIGNED_ROW_CAP,
    physical_schemas: result.physical_schemas,
    ...(result.physical_schema ? {
      history_schema_version: result.physical_schema.history_schema_version,
      writer_version: result.physical_schema.writer_version,
    } : {}),
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
    ...(diagnosticContext?.mode === EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE
      ? { coverage: { exact_reader_diagnostics: result.diagnostics } }
      : {}),
    ...(diagnosticContext?.mode === EXACT_HISTORY_CPU_DIAGNOSTIC_MODE
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
      assertGenerationConfiguration(env);
      if (url.pathname === DAILY_PROVENANCE_PATH) {
        const params = parseDailyProvenanceRequest(url);
        if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
        return await handleDailyProvenance(params, env);
      }
      if (url.pathname === "/v1/timeseries-binding") {
        assertGenerationConfiguration(env);
        const params = parseBindingRequest(url);
        if (!params.ok) return jsonResponse({ ok: false, error: params.error }, { status: params.status, noStore: true });
        const key = cacheKey(request.url, "v3-binding");
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
        if (context.mode === EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE) {
          console.info(JSON.stringify({
            event: "observation_history_v3_physical_leaf_workload_diagnostic_start",
            diagnostic_request_id: context.request_id,
            cloudflare_ray_id: context.cloudflare_ray_id,
            connector_id: params.connectorId,
            pollutant_code: params.pollutantCode,
            timeseries_id: params.timeseriesId,
            start_utc: params.startIso,
            end_utc: params.endIso,
            physical_cursor_supplied: Boolean(params.physicalCursor),
          }));
        }
        const verificationAuthority = await loadObservationVerificationAuthority({
          bucket: env.UK_AQ_HISTORY_BUCKET,
          connectorId: params.connectorId,
          cache: caches.default,
        });
        return withCacheHeaders(
          await handleObservations(
            params,
            env,
            context,
            verificationAuthority,
          ),
          "BYPASS",
          RESPONSE_CACHE_GENERATION,
        );
      }
      const verificationDiscovery = await loadObservationVerificationDiscovery({
        bucket: env.UK_AQ_HISTORY_BUCKET,
        cache: caches.default,
      });
      const verificationManifestIdentity = observationVerificationManifestIdentityForConnector({
        discovery: verificationDiscovery,
        connectorId: params.connectorId,
      });
      const key = cacheKey(
        request.url,
        INDEX_GENERATION,
        verificationManifestIdentity?.sha256 || null,
      );
      const cached = await caches.default.match(key);
      if (cached) return withCacheHeaders(cached, "HIT", RESPONSE_CACHE_GENERATION);
      const verificationAuthority = await loadObservationVerificationAuthority({
        bucket: env.UK_AQ_HISTORY_BUCKET,
        connectorId: params.connectorId,
        discovery: verificationDiscovery,
        cache: caches.default,
      });
      const response = await handleObservations(
        params,
        env,
        null,
        verificationAuthority,
      );
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
      const responseError = context?.mode === EXACT_HISTORY_CPU_DIAGNOSTIC_MODE
        ? (errorCode || "physical_leaf_cpu_measurement_failed")
        : errorMessage;
      const diagnosticRequest = diagnosticPayload(context, { outcome: "error" });
      const compactError = compactErrorSummary(diagnostics);
      if (context?.mode === EXACT_HISTORY_CPU_DIAGNOSTIC_MODE) {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_cpu_measurement",
          diagnostic_request_id: context.request_id,
          cloudflare_ray_id: context.cloudflare_ray_id,
          ...(errorCode ? { error_code: errorCode } : {}),
          ...compactError,
        }));
      } else if (context?.mode === EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE) {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_workload_diagnostic_error",
          diagnostic_request_id: context.request_id,
          cloudflare_ray_id: context.cloudflare_ray_id,
          ...(errorCode ? { error_code: errorCode } : {}),
          ...compactError,
        }));
      } else {
        console.warn(JSON.stringify({
          event: "observation_history_v3_physical_leaf_error",
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
        ...(context?.mode === EXACT_HISTORY_WORKLOAD_DIAGNOSTIC_MODE && diagnostics
          ? { diagnostics }
          : {}),
        ...(context?.mode === EXACT_HISTORY_CPU_DIAGNOSTIC_MODE
          ? { cpu_measurement: compactError }
          : {}),
        ...(diagnosticRequest ? { diagnostic_request: diagnosticRequest } : {}),
      }, { status, noStore: true, extraHeaders: diagnosticHeaders(context) });
    }
  },
};
