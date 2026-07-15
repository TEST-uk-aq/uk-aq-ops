import {
  dedupeSourceObservationRows,
  helperRowsToNormalizedAqiV1Rows,
  normalizePollutantCode,
  pivotNarrowRowsToHelperRows,
  sourceObservationsToNarrowRows,
} from "../../../lib/aqi/aqi_levels.mjs";
import {
  mergeStableAqiHead,
  missingHeadHours,
  normalizeExactR2AqiRows,
  r2CoverageClaimsComplete,
  r2ResponseComplete,
  resolveStableHeadBounds,
} from "./stable_head.mjs";
import {
  aqiResponseRows,
  buildAqiHistoryChunk,
  buildObservationHistoryChunk,
  buildTsv,
  parseHistoryChunkRequest,
} from "./history_chunks.mjs";
import {
  applyAuthoritativeTimeseriesIdentity,
  publicTimeseriesIdentity,
  resolveAuthoritativeTimeseriesIdentity,
  StationHistoryIdentityError,
} from "./identity.mjs";
import {
  readDirectIngestObservations,
  StationHistoryIngestError,
} from "./ingest_observations.mjs";
import { mergeObservationRowsPreferR2, readR2Observations } from "./r2_observations.mjs";
import { resolveStationHistoryPolicy } from "./policy.mjs";

const CONTRACT_VERSION = "v1";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function headersFor(responseHeaders = undefined) {
  const headers = new Headers(responseHeaders);
  headers.set("X-UK-AQ-Station-History-Contract", CONTRACT_VERSION);
  headers.set("X-UK-AQ-Station-History-Worker", "uk-aq-station-history");
  return headers;
}

function errorResponse(status, code, route, detail = undefined) {
  return new Response(JSON.stringify({ ok: false, error: { code, route, ...(detail ? { detail } : {}) } }), {
    status,
    headers: headersFor({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }),
  });
}

function ingestErrorResponse(error, route) {
  if (!(error instanceof StationHistoryIngestError)) return null;

  const response = errorResponse(
    error.status,
    error.code,
    route,
    error.toSafeDetail(),
  );
  const headers = new Headers(response.headers);
  headers.set("X-UK-AQ-Station-History-Upstream", "ingestdb");
  headers.set(
    "X-UK-AQ-Station-History-Error-Class",
    error.failureClass,
  );
  if (error.upstreamStatus !== null && error.upstreamStatus !== undefined) {
    headers.set(
      "X-UK-AQ-Station-History-Upstream-Status",
      String(error.upstreamStatus),
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function required(value) { return String(value ?? "").trim(); }
function positiveInt(value) { const n = Number(String(value ?? "").trim()); return Number.isInteger(n) && n > 0 ? n : null; }
function includeAqi(value) { return !["0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase()); }

export function resolveStationSeriesRequest(url) {
  const timeseriesId = positiveInt(url.searchParams.get("timeseries_id"));
  const connectorText = required(url.searchParams.get("connector_id"));
  const connectorId = connectorText ? positiveInt(connectorText) : null;
  const pollutant = normalizePollutantCode(url.searchParams.get("pollutant"));
  const startMs = Date.parse(String(url.searchParams.get("start_utc") ?? ""));
  const endMs = Date.parse(String(url.searchParams.get("end_utc") ?? ""));
  if (!timeseriesId || (connectorText && !connectorId) || !pollutant || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const aqiEnabled = includeAqi(url.searchParams.get("include_aqi"));
  const contextHours = aqiEnabled && (pollutant === "pm25" || pollutant === "pm10") ? 23 : 0;
  return {
    timeseriesId, connectorId, pollutant, startMs, endMs, contextHours,
    contextStartMs: startMs - contextHours * HOUR_MS,
    includeAqi: aqiEnabled,
    window: required(url.searchParams.get("window")) || null,
  };
}

function identityErrorResponse(error, route) {
  if (!(error instanceof StationHistoryIdentityError)) return null;
  const response = errorResponse(error.status, error.code, route, error.detail);
  const headers = new Headers(response.headers);
  headers.set("X-UK-AQ-Station-History-Identity-Error", error.code);
  return new Response(response.body, { status: response.status, headers });
}

function attachAuthoritativeIdentity(body, identity) {
  const authoritative = publicTimeseriesIdentity(identity);
  return { ...body, request: { ...body.request, ...authoritative, pollutant: authoritative.pollutant }, identity: authoritative };
}

function hourStarts(startMs, endMs) {
  const values = [];
  for (let cursor = Math.floor(startMs / HOUR_MS) * HOUR_MS; cursor < endMs; cursor += HOUR_MS) values.push(cursor);
  return values;
}

function missingHourRanges(rows, startMs, endMs, field) {
  const present = new Set((Array.isArray(rows) ? rows : []).map((row) => Math.floor(Date.parse(String(row?.[field] ?? "")) / HOUR_MS) * HOUR_MS).filter(Number.isFinite));
  return hourStarts(startMs, endMs).filter((hour) => !present.has(hour)).map((hour) => ({ start_utc: new Date(hour).toISOString(), end_utc: new Date(hour + HOUR_MS).toISOString() }));
}

function calculateAqiRows(observationRows, request, startMs, endMs) {
  return helperRowsToNormalizedAqiV1Rows(
    pivotNarrowRowsToHelperRows(sourceObservationsToNarrowRows(observationRows)),
    { computedAtUtc: null },
  ).filter((row) => {
    const timestamp = Date.parse(row.timestamp_hour_utc);
    return timestamp >= startMs && timestamp < endMs
      && row.timeseries_id === request.timeseriesId
      && row.connector_id === request.connectorId
      && row.pollutant_code === request.pollutant;
  }).map((row) => ({ ...row, source: "live_calculated" }));
}

function aqiAvailabilityDiagnostics(rows) {
  const diagnostics = {
    daqi_available_row_count: 0,
    eaqi_available_row_count: 0,
    daqi_missing_row_count: 0,
    eaqi_missing_row_count: 0,
    daqi_insufficient_context_row_count: 0,
    live_only_eaqi_row_count: 0,
    live_only_daqi_row_count: 0,
    live_neither_index_row_count: 0,
    daqi_missing_hours: [],
    eaqi_missing_hours: [],
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const hasDaqi = row?.daqi_index_level !== null && row?.daqi_index_level !== undefined;
    const hasEaqi = row?.eaqi_index_level !== null && row?.eaqi_index_level !== undefined;
    const hour = String(row?.timestamp_hour_utc || "");
    if (hasDaqi) diagnostics.daqi_available_row_count += 1;
    else {
      diagnostics.daqi_missing_row_count += 1;
      if (hour) diagnostics.daqi_missing_hours.push(hour);
    }
    if (hasEaqi) diagnostics.eaqi_available_row_count += 1;
    else {
      diagnostics.eaqi_missing_row_count += 1;
      if (hour) diagnostics.eaqi_missing_hours.push(hour);
    }
    if (row?.daqi_calculation_status === "insufficient_samples") {
      diagnostics.daqi_insufficient_context_row_count += 1;
    }
    if (row?.source === "live_calculated") {
      if (!hasDaqi && hasEaqi) diagnostics.live_only_eaqi_row_count += 1;
      else if (hasDaqi && !hasEaqi) diagnostics.live_only_daqi_row_count += 1;
      else if (!hasDaqi && !hasEaqi) diagnostics.live_neither_index_row_count += 1;
    }
  }
  diagnostics.daqi_missing_hours.sort();
  diagnostics.eaqi_missing_hours.sort();
  return diagnostics;
}

function aqiAvailabilityComplete(diagnostics) {
  return diagnostics.daqi_missing_row_count === 0
    && diagnostics.eaqi_missing_row_count === 0;
}

function ingestCapability({ request, direct, aqiBounds, observationBounds, retentionStartMs }) {
  const outputStartMs = Math.min(aqiBounds.headStartMs, observationBounds.headStartMs);
  const outputRows = direct.rows.filter((row) => Date.parse(row.observed_at) >= outputStartMs && Date.parse(row.observed_at) < request.endMs);
  const observationGaps = missingHourRanges(outputRows, observationBounds.headStartMs, request.endMs, "observed_at");
  const contextStartMs = request.includeAqi ? aqiBounds.headStartMs - request.contextHours * HOUR_MS : observationBounds.headStartMs;
  const contextGaps = request.includeAqi ? missingHourRanges(direct.rows, contextStartMs, aqiBounds.headStartMs, "observed_at") : [];
  const coversWholeRequest = aqiBounds.headStartMs === request.startMs && observationBounds.headStartMs === request.startMs;
  const withinRetention = contextStartMs >= retentionStartMs;
  const observationsComplete = direct.response_complete && observationGaps.length === 0;
  const aqiContextComplete = !request.includeAqi || (direct.response_complete && contextGaps.length === 0);
  return {
    qualifies: coversWholeRequest && withinRetention && observationsComplete && aqiContextComplete,
    observationsComplete,
    aqiContextComplete,
    observationGaps,
    contextGaps,
  };
}

function disabledAqiSection() {
  return { enabled: false, state: "disabled", rows: [], response_complete: false, has_gap: false, gap_ranges: [], next_chunk_end_utc: null, next_older_aqi_chunk_end_utc: null, source_counts: { r2: 0, live_calculated: 0 }, mismatch_count: 0 };
}

function requestFields(request) {
  return { timeseries_id: request.timeseriesId, connector_id: request.connectorId, pollutant: request.pollutant, start_utc: new Date(request.startMs).toISOString(), end_utc: new Date(request.endMs).toISOString(), window: request.window, format: "objects", include_aqi: request.includeAqi };
}

function directDiagnostics(direct, outputRows) {
  return {
    raw_ingest_row_count: direct.raw_row_count,
    normalized_ingest_row_count: direct.normalized_row_count,
    rejected_ingest_row_count: direct.rejected_row_count,
    output_ingest_row_count: outputRows.filter((row) => row.source === "ingest").length,
    ingest_source_path: direct.source_path,
    ingest_fetch_count: direct.fetch_count,
    logical_ingest_fetch_count: direct.logical_fetch_count,
    ingest_http_attempt_count: direct.http_attempt_count,
    ingest_rpc_window_label: direct.rpc_window_label,
    ingest_rpc_window_start_utc: direct.rpc_window_start_utc,
    ingest_rpc_window_end_utc: direct.rpc_window_end_utc,
    ingest_rpc_window_covers_required_start: direct.rpc_window_covers_required_start,
  };
}

function buildIngestOnlyResponse(request, direct, capability) {
  const observations = direct.rows.filter((row) => {
    const ms = Date.parse(row.observed_at);
    return ms >= request.startMs && ms < request.endMs;
  });
  const aqiRows = request.includeAqi ? calculateAqiRows(direct.rows, request, request.startMs, request.endMs) : [];
  const aqiAvailability = aqiAvailabilityDiagnostics(aqiRows);
  const aqiGaps = request.includeAqi ? [...capability.contextGaps, ...missingHourRanges(aqiRows, request.startMs, request.endMs, "timestamp_hour_utc")] : [];
  const aqiComplete = request.includeAqi && direct.response_complete && capability.aqiContextComplete
    && aqiGaps.length === 0 && aqiAvailabilityComplete(aqiAvailability);
  const observationComplete = direct.response_complete && capability.observationsComplete;
  return {
    schema_version: 1,
    request: requestFields(request),
    source: {
      mode: request.includeAqi ? "ingest_only" : "ingest_observations_only",
      required_context_start_utc: new Date(request.contextStartMs).toISOString(),
      output_start_utc: new Date(request.startMs).toISOString(), output_end_utc: new Date(request.endMs).toISOString(),
      direct_ingest_start_utc: direct.start_utc, direct_ingest_end_utc: direct.end_utc,
      aqi_r2_coverage_end_utc: null, observations_r2_coverage_end_utc: null, observation_overlap_start_utc: null,
      ingest_response_complete: direct.response_complete, r2_aqi_response_complete: null, r2_observations_response_complete: null,
      used_recent_r2_aqi: false, used_r2_observations: false, r2_aqi_fetch_count: 0, r2_observation_fetch_count: 0,
      ...directDiagnostics(direct, observations),
    },
    aqi: request.includeAqi
      ? { enabled: true, rows: aqiRows, response_complete: aqiComplete, has_gap: !aqiComplete, gap_ranges: aqiGaps, availability: aqiAvailability, stable_head_start_utc: new Date(request.startMs).toISOString(), stable_head_end_utc: new Date(request.endMs).toISOString(), next_chunk_end_utc: null, next_older_aqi_chunk_end_utc: null, stable_head_locked: aqiComplete, replacement_policy: "extend_backwards_only", source_counts: { r2: 0, live_calculated: aqiRows.length }, overlap_count: 0, mismatch_count: 0, mismatch_hours: [] }
      : disabledAqiSection(),
    observations: { rows: observations, guideline: direct.guideline, response_complete: observationComplete, has_gap: !observationComplete, gap_ranges: capability.observationGaps, stable_head_start_utc: new Date(request.startMs).toISOString(), stable_head_end_utc: new Date(request.endMs).toISOString(), next_chunk_end_utc: null, next_older_observation_chunk_end_utc: null, source_counts: { r2: 0, ingest: observations.length }, discarded_ingest_overlap_count: 0 },
  };
}

async function fetchR2AqiHead(request, bounds, env, rowLimit) {
  const baseUrl = required(env.UK_AQ_AQI_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) throw new Error("station_series_r2_config_missing");
  const target = new URL(baseUrl);
  target.search = "";
  target.searchParams.set("scope", "timeseries"); target.searchParams.set("grain", "hourly");
  target.searchParams.set("timeseries_id", String(request.timeseriesId)); target.searchParams.set("connector_id", String(request.connectorId));
  target.searchParams.set("pollutant", request.pollutant); target.searchParams.set("start_utc", new Date(bounds.headStartMs).toISOString());
  target.searchParams.set("end_utc", new Date(bounds.headEndMs).toISOString()); target.searchParams.set("row_limit", String(rowLimit)); target.searchParams.set("format", "objects");
  const response = await fetch(target.toString(), { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") throw new Error("station_series_r2_aqi_failed");
  if (r2CoverageClaimsComplete(payload) && !r2ResponseComplete(payload)) throw new Error("station_series_r2_claimed_complete_response_incomplete");
  return payload;
}

function latestR2AqiCoverageEnd(rows) {
  const latest = rows.reduce((value, row) => Math.max(value, Date.parse(row.timestamp_hour_utc)), Number.NEGATIVE_INFINITY);
  return Number.isFinite(latest) ? new Date(latest + HOUR_MS).toISOString() : null;
}

async function buildR2LiveResponse(request, env, policy, direct, aqiBounds, observationBounds) {
  let r2Payload = null;
  let r2AqiRows = [];
  let missing = [];
  if (request.includeAqi) {
    r2Payload = await fetchR2AqiHead(request, aqiBounds, env, policy.stableAqiHeadMaxHours);
    r2AqiRows = normalizeExactR2AqiRows(r2Payload, request, aqiBounds);
    missing = missingHeadHours(r2AqiRows, aqiBounds);
  }
  const observationContextStartMs = Math.min(observationBounds.headStartMs, aqiBounds.headStartMs - request.contextHours * HOUR_MS);
  const overlapEndMs = Math.min(request.endMs, Math.max(observationContextStartMs + HOUR_MS, Date.parse(direct.start_utc) + policy.observationOverlapHours * HOUR_MS));
  const r2Observations = await readR2Observations({ env, identity: request, startMs: observationContextStartMs, endMs: overlapEndMs });
  const mergedObservations = mergeObservationRowsPreferR2({ r2Rows: r2Observations.rows, ingestRows: direct.rows });
  const calculationRows = dedupeSourceObservationRows(mergedObservations.rows);
  const outputObservations = mergedObservations.rows.filter((row) => {
    const ms = Date.parse(row.observed_at);
    return ms >= observationBounds.headStartMs && ms < request.endMs;
  });
  const observationGaps = missingHourRanges(outputObservations, observationBounds.headStartMs, request.endMs, "observed_at");
  const observationsComplete = direct.response_complete && r2Observations.response_complete && observationGaps.length === 0;

  let mergedAqi = { rows: [], overlap_count: 0, mismatch_count: 0, mismatch_hours: [] };
  let liveRows = [];
  let aqiComplete = false;
  let aqiAvailability = aqiAvailabilityDiagnostics([]);
  if (request.includeAqi) {
    const missingSet = new Set(missing);
    // The shared AQI helper calculates DAQI and EAQI independently. Retain a
    // candidate for every R2-missing output hour that has source observations;
    // incomplete PM rolling context may make DAQI null without suppressing a
    // valid hourly EAQI result.
    liveRows = calculateAqiRows(calculationRows, request, aqiBounds.headStartMs, aqiBounds.headEndMs)
      .filter((row) => missingSet.has(row.timestamp_hour_utc));
    mergedAqi = mergeStableAqiHead({ r2Rows: r2AqiRows, liveRows, request, bounds: aqiBounds });
    const remaining = missingHourRanges(mergedAqi.rows, aqiBounds.headStartMs, aqiBounds.headEndMs, "timestamp_hour_utc");
    aqiAvailability = aqiAvailabilityDiagnostics(mergedAqi.rows);
    const liveSourceComplete = missing.length === 0 || direct.response_complete;
    aqiComplete = r2ResponseComplete(r2Payload) && liveSourceComplete
      && remaining.length === 0 && aqiAvailabilityComplete(aqiAvailability);
  }

  const aqiHeadStartUtc = new Date(aqiBounds.headStartMs).toISOString();
  const observationHeadStartUtc = new Date(observationBounds.headStartMs).toISOString();
  const aqiGaps = request.includeAqi ? missingHourRanges(mergedAqi.rows, aqiBounds.headStartMs, aqiBounds.headEndMs, "timestamp_hour_utc") : [];
  const sourceMode = request.includeAqi ? "stable_r2_live_head" : "r2_ingest_observations_head";
  console.log(JSON.stringify({ event: "station_series_source_merge", timeseries_id: request.timeseriesId, connector_id: request.connectorId, pollutant: request.pollutant, r2_aqi_rows: r2AqiRows.length, live_aqi_rows: liveRows.length, r2_observation_rows: r2Observations.rows.length, ingest_observation_rows: outputObservations.filter((row) => row.source === "ingest").length, discarded_ingest_observation_overlap_count: mergedObservations.discarded_ingest_overlap_count, aqi_overlap_count: mergedAqi.overlap_count, aqi_mismatch_count: mergedAqi.mismatch_count, aqi_mismatch_hours: mergedAqi.mismatch_hours, aqi_complete: aqiComplete, observations_complete: observationsComplete }));
  return {
    schema_version: 1,
    request: requestFields(request),
    source: {
      mode: (request.includeAqi ? aqiComplete : true) && observationsComplete ? sourceMode : `${sourceMode}_incomplete`,
      required_context_start_utc: new Date(aqiBounds.headStartMs - request.contextHours * HOUR_MS).toISOString(),
      output_start_utc: new Date(Math.min(aqiBounds.headStartMs, observationBounds.headStartMs)).toISOString(), output_end_utc: new Date(request.endMs).toISOString(),
      direct_ingest_start_utc: direct.start_utc, direct_ingest_end_utc: direct.end_utc,
      aqi_r2_coverage_end_utc: latestR2AqiCoverageEnd(r2AqiRows),
      observations_r2_coverage_end_utc: r2Observations.response_complete ? r2Observations.end_utc : null,
      observation_overlap_start_utc: direct.start_utc,
      ingest_response_complete: direct.response_complete,
      r2_aqi_response_complete: r2Payload ? r2ResponseComplete(r2Payload) : null,
      r2_observations_response_complete: r2Observations.response_complete,
      used_recent_r2_aqi: Boolean(request.includeAqi), used_r2_observations: true,
      r2_aqi_fetch_count: request.includeAqi ? 1 : 0, r2_observation_fetch_count: 1,
      r2_aqi_row_count: r2AqiRows.length, live_calculated_aqi_row_count: liveRows.length,
      r2_observation_row_count: outputObservations.filter((row) => row.source === "r2").length,
      ingest_observation_row_count: outputObservations.filter((row) => row.source === "ingest").length,
      discarded_ingest_observation_overlap_count: mergedObservations.discarded_ingest_overlap_count,
      live_calculation_observation_sources: { r2: mergedObservations.rows.filter((row) => row.source === "r2").length, ingest: mergedObservations.rows.filter((row) => row.source === "ingest").length },
      ...directDiagnostics(direct, outputObservations),
    },
    aqi: request.includeAqi ? {
      enabled: true, rows: mergedAqi.rows, response_complete: aqiComplete, has_gap: !aqiComplete, gap_ranges: aqiGaps,
      stable_head_start_utc: aqiHeadStartUtc, stable_head_end_utc: new Date(aqiBounds.headEndMs).toISOString(),
      next_chunk_end_utc: aqiBounds.headStartMs > request.startMs ? aqiHeadStartUtc : null,
      next_older_aqi_chunk_end_utc: aqiBounds.headStartMs > request.startMs ? aqiHeadStartUtc : null,
      stable_head_locked: aqiComplete, replacement_policy: "extend_backwards_only",
      source_counts: { r2: r2AqiRows.length, live_calculated: liveRows.length }, availability: aqiAvailability, overlap_count: mergedAqi.overlap_count, mismatch_count: mergedAqi.mismatch_count, mismatch_hours: mergedAqi.mismatch_hours,
    } : disabledAqiSection(),
    observations: {
      rows: outputObservations, guideline: direct.guideline, response_complete: observationsComplete, has_gap: !observationsComplete, gap_ranges: observationGaps,
      stable_head_start_utc: observationHeadStartUtc, stable_head_end_utc: new Date(request.endMs).toISOString(),
      next_chunk_end_utc: observationBounds.headStartMs > request.startMs ? observationHeadStartUtc : null,
      next_older_observation_chunk_end_utc: observationBounds.headStartMs > request.startMs ? observationHeadStartUtc : null,
      source_counts: { r2: outputObservations.filter((row) => row.source === "r2").length, ingest: outputObservations.filter((row) => row.source === "ingest").length },
      discarded_ingest_overlap_count: mergedObservations.discarded_ingest_overlap_count,
    },
  };
}

export async function buildStationSeries(request, env, nowMs = Date.now()) {
  const policy = resolveStationHistoryPolicy(env);
  const aqiBounds = resolveStableHeadBounds(request, policy.stableAqiHeadMaxHours);
  const observationBounds = resolveStableHeadBounds(request, policy.observationChunkMaxHours);
  const requiredStartMs = Math.min(observationBounds.headStartMs, aqiBounds.headStartMs - request.contextHours * HOUR_MS);
  const retentionStartMs = nowMs - policy.ingestRetentionDays * DAY_MS;
  const latestPossibleStartMs = request.endMs - HOUR_MS;
  const directStartMs = Math.min(Math.max(requiredStartMs, retentionStartMs), latestPossibleStartMs);
  const direct = await readDirectIngestObservations({ env, identity: request, startMs: directStartMs, endMs: request.endMs, nowMs, timeoutMs: policy.obsAqiDbTimeoutMs });
  const capability = ingestCapability({ request, direct, aqiBounds, observationBounds, retentionStartMs });
  if (capability.qualifies) return buildIngestOnlyResponse(request, direct, capability);
  return buildR2LiveResponse(request, env, policy, direct, aqiBounds, observationBounds);
}

async function fetchJsonUpstream(target, secret, failureCode) {
  try {
    const response = await fetch(target.toString(), { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") throw new Error(failureCode);
    return payload;
  } catch (_error) {
    throw new Error(failureCode);
  }
}

function chunkHeaders(body) {
  const complete = body.response_complete === true;
  const immutable = body.chunk.cache_class === "immutable";
  return headersFor({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": complete ? (immutable ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300") : "no-store", "X-UK-AQ-Chunk-Direction": body.chunk.direction, "X-UK-AQ-Chunk-Start": body.chunk.start_utc, "X-UK-AQ-Chunk-End": body.chunk.end_utc, "X-UK-AQ-Next-Older-Chunk-End": body.chunk.next_older_chunk_end_utc, "X-UK-AQ-Chunk-Cache-Class": body.chunk.cache_class, "X-UK-AQ-Chunk-Retry-Key": body.chunk.retry_key, "X-UK-AQ-Response-Complete": String(complete) });
}

async function handleAqiHistoryChunk(request, env) {
  const url = new URL(request.url);
  const parsed = parseHistoryChunkRequest(url, "aqi", resolveStationHistoryPolicy(env));
  if (!parsed.ok) return errorResponse(parsed.code === "history_chunk_overlaps_stable_head" ? 409 : 400, parsed.code, url.pathname);
  let chunk;
  try { chunk = applyAuthoritativeTimeseriesIdentity(parsed, await resolveAuthoritativeTimeseriesIdentity(parsed, env)); }
  catch (error) { return identityErrorResponse(error, url.pathname) || errorResponse(502, "station_history_identity_lookup_failed", url.pathname); }
  const baseUrl = required(env.UK_AQ_AQI_HISTORY_R2_API_URL); const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) return errorResponse(500, "internal_aqi_history_config_missing", url.pathname);
  const target = new URL(baseUrl); target.search = "";
  for (const [key, value] of [["scope", "timeseries"], ["grain", "hourly"], ["timeseries_id", chunk.timeseriesId], ["connector_id", chunk.connectorId], ["pollutant", chunk.pollutant], ["start_utc", chunk.startUtc], ["end_utc", chunk.endUtc], ["row_limit", chunk.limit], ["format", "objects"]]) target.searchParams.set(key, String(value));
  try {
    const body = buildAqiHistoryChunk(chunk, await fetchJsonUpstream(target, secret, "aqi_history_r2_failed"));
    const formatted = aqiResponseRows(body, chunk.format); body.columns = formatted.columns; body.points = formatted.points;
    const headers = chunkHeaders(body);
    if (chunk.format === "tsv") { headers.set("Content-Type", "text/tab-separated-values; charset=utf-8"); return new Response(buildTsv(formatted.columns, formatted.points), { status: 200, headers }); }
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (error) { return errorResponse(502, error instanceof Error ? error.message : "aqi_history_r2_failed", url.pathname); }
}

async function handleObservationHistoryChunk(request, env) {
  const url = new URL(request.url);
  const parsed = parseHistoryChunkRequest(url, "observations", resolveStationHistoryPolicy(env));
  if (!parsed.ok) return errorResponse(parsed.code === "history_chunk_overlaps_stable_head" ? 409 : 400, parsed.code, url.pathname);
  let chunk;
  try { chunk = applyAuthoritativeTimeseriesIdentity(parsed, await resolveAuthoritativeTimeseriesIdentity(parsed, env)); }
  catch (error) { return identityErrorResponse(error, url.pathname) || errorResponse(502, "station_history_identity_lookup_failed", url.pathname); }
  const baseUrl = required(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL); const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) return errorResponse(500, "internal_observation_history_config_missing", url.pathname);
  const target = new URL(baseUrl); if (!target.pathname || target.pathname === "/") target.pathname = "/v1/observations"; target.search = "";
  for (const [key, value] of [["timeseries_id", chunk.timeseriesId], ["connector_id", chunk.connectorId], ["pollutant", chunk.pollutant], ["start_utc", chunk.startUtc], ["end_utc", chunk.endUtc], ["limit", chunk.limit]]) target.searchParams.set(key, String(value));
  try { const body = buildObservationHistoryChunk(chunk, await fetchJsonUpstream(target, secret, "observation_history_r2_failed")); return new Response(JSON.stringify(body), { status: 200, headers: chunkHeaders(body) }); }
  catch (error) { return errorResponse(502, error instanceof Error ? error.message : "observation_history_r2_failed", url.pathname); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return errorResponse(405, "internal_method_not_allowed", url.pathname);
    if (url.pathname === "/v1/aqi-history") return handleAqiHistoryChunk(request, env);
    if (url.pathname === "/v1/observations-history") return handleObservationHistoryChunk(request, env);
    if (url.pathname !== "/v1/station-series") return errorResponse(404, "internal_route_not_found", url.pathname);
    if (String(url.searchParams.get("format") ?? "").toLowerCase() !== "objects") return errorResponse(400, "station_series_format_objects_required", url.pathname);
    const parsed = resolveStationSeriesRequest(url);
    if (!parsed) return errorResponse(400, "station_series_request_invalid", url.pathname);
    try {
      const identity = await resolveAuthoritativeTimeseriesIdentity(parsed, env);
      const authoritative = applyAuthoritativeTimeseriesIdentity(parsed, identity);
      const body = attachAuthoritativeIdentity(await buildStationSeries(authoritative, env), identity);
      const complete = (!authoritative.includeAqi || body.aqi.response_complete === true) && body.observations.response_complete === true;
      return new Response(JSON.stringify(body), { status: 200, headers: headersFor({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": complete ? "public, max-age=60, s-maxage=60" : "no-store", "X-UK-AQ-Station-History-Source-Mode": body.source.mode, "X-UK-AQ-Station-History-Ingest-Fetches": String(body.source.ingest_fetch_count) }) });
    } catch (error) {
      return ingestErrorResponse(error, url.pathname)
        || identityErrorResponse(error, url.pathname)
        || errorResponse(502, error instanceof Error ? error.message : "station_series_failed", url.pathname);
    }
  },
};

export { CONTRACT_VERSION, errorResponse };
