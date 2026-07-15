import {
  dedupeSourceObservationRows,
  helperRowsToNormalizedAqiV1Rows,
  normalizePollutantCode,
  pivotNarrowRowsToHelperRows,
  sourceObservationsToNarrowRows,
} from "../../../lib/aqi/aqi_levels.mjs";
import {
  STABLE_HEAD_MAX_HOURS,
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

const CONTRACT_VERSION = "v1";
const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const HOUR_MS = 60 * 60 * 1000;

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

function required(value) { return String(value ?? "").trim(); }

function parsePositiveInt(value) {
  const numeric = Number(String(value ?? "").trim());
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseBounds(url) {
  const startMs = Date.parse(String(url.searchParams.get("start_utc") ?? ""));
  const endMs = Date.parse(String(url.searchParams.get("end_utc") ?? ""));
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : null;
}

function outputHours(startMs, endMs) {
  const hours = [];
  for (let cursor = Math.floor(startMs / HOUR_MS) * HOUR_MS; cursor < endMs; cursor += HOUR_MS) hours.push(cursor);
  return hours;
}

function responseRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.rows) ? payload.rows : [];
}

function sourceComplete(payload, rows, contextStartMs, endMs) {
  if (payload?.response_complete === false || payload?.meta?.response_complete === false) return false;
  const observedHours = new Set(rows.map((row) => Math.floor(Date.parse(row.observed_at) / HOUR_MS) * HOUR_MS).filter(Number.isFinite));
  return outputHours(contextStartMs, endMs).every((hour) => observedHours.has(hour));
}

function gapRanges(rows, startMs, endMs, timestampField) {
  const present = new Set(rows.map((row) => Math.floor(Date.parse(row[timestampField]) / HOUR_MS) * HOUR_MS).filter(Number.isFinite));
  return outputHours(startMs, endMs).filter((hour) => !present.has(hour)).map((hour) => ({
    start_utc: new Date(hour).toISOString(), end_utc: new Date(hour + HOUR_MS).toISOString(),
  }));
}

export function resolveStationSeriesRequest(url) {
  const timeseriesId = parsePositiveInt(url.searchParams.get("timeseries_id"));
  const connectorId = parsePositiveInt(url.searchParams.get("connector_id"));
  const pollutant = normalizePollutantCode(url.searchParams.get("pollutant"));
  const bounds = parseBounds(url);
  if (!timeseriesId || !connectorId || !pollutant || !bounds) return null;
  const contextHours = pollutant === "pm25" || pollutant === "pm10" ? 23 : 0;
  return {
    timeseriesId, connectorId, pollutant, contextHours,
    startMs: bounds.startMs, endMs: bounds.endMs,
    contextStartMs: bounds.startMs - contextHours * HOUR_MS,
    window: String(url.searchParams.get("window") ?? "").trim() || null,
  };
}

export function buildStationSeriesFromIngest(request, ingestPayload) {
  const normalised = dedupeSourceObservationRows(responseRows(ingestPayload)).filter((row) =>
    row.timeseries_id === request.timeseriesId && row.connector_id === request.connectorId && row.pollutant_code === request.pollutant
  );
  const ingestComplete = sourceComplete(ingestPayload, normalised, request.contextStartMs, request.endMs);
  const observationRows = normalised.filter((row) => {
    const timestamp = Date.parse(row.observed_at);
    return timestamp >= request.startMs && timestamp < request.endMs;
  }).map((row) => ({ ...row, source: "ingest" }));
  const aqiRows = helperRowsToNormalizedAqiV1Rows(
    pivotNarrowRowsToHelperRows(sourceObservationsToNarrowRows(normalised)),
    { computedAtUtc: null },
  ).filter((row) => {
    const timestamp = Date.parse(row.timestamp_hour_utc);
    return timestamp >= request.startMs && timestamp < request.endMs && row.timeseries_id === request.timeseriesId && row.pollutant_code === request.pollutant;
  }).map((row) => ({ ...row, source: "live_calculated" }));
  const observationGaps = gapRanges(observationRows, request.startMs, request.endMs, "observed_at");
  const aqiGaps = gapRanges(aqiRows, request.startMs, request.endMs, "timestamp_hour_utc");
  const outputComplete = ingestComplete && observationGaps.length === 0;
  const aqiComplete = outputComplete && aqiGaps.length === 0;
  const outputStartUtc = new Date(request.startMs).toISOString();
  return {
    schema_version: 1,
    request: { timeseries_id: request.timeseriesId, connector_id: request.connectorId, pollutant: request.pollutant, start_utc: outputStartUtc, end_utc: new Date(request.endMs).toISOString(), window: request.window, format: "objects" },
    source: {
      mode: outputComplete ? "ingest_only" : "ingest_incomplete",
      required_context_start_utc: new Date(request.contextStartMs).toISOString(),
      output_start_utc: outputStartUtc,
      output_end_utc: new Date(request.endMs).toISOString(),
      ingest_response_complete: ingestComplete,
      used_recent_r2_aqi: false,
      used_r2_observations: false,
      ingest_row_count: normalised.length,
      ingest_fetch_count: 1,
      r2_aqi_fetch_count: 0,
    },
    aqi: { rows: aqiRows, response_complete: aqiComplete, has_gap: !aqiComplete, gap_ranges: aqiGaps, next_chunk_end_utc: outputStartUtc, source_counts: { r2: 0, live_calculated: aqiRows.length }, mismatch_count: 0 },
    observations: { rows: observationRows, response_complete: outputComplete, has_gap: !outputComplete, gap_ranges: observationGaps, next_chunk_end_utc: outputStartUtc, source_counts: { ingest: observationRows.length } },
  };
}

async function fetchIngestOnce(request, env) {
  const supabaseUrl = required(env.SUPABASE_URL);
  const publishableKey = required(env.SB_PUBLISHABLE_DEFAULT_KEY);
  const upstreamSecret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!supabaseUrl || !publishableKey || !upstreamSecret) throw new Error("station_series_config_missing");
  const target = new URL(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/uk_aq_timeseries`);
  target.searchParams.set("timeseries_id", String(request.timeseriesId));
  target.searchParams.set("connector_id", String(request.connectorId));
  target.searchParams.set("pollutant", request.pollutant);
  target.searchParams.set("start_utc", new Date(request.contextStartMs).toISOString());
  target.searchParams.set("end_utc", new Date(request.endMs).toISOString());
  target.searchParams.set("format", "objects");
  const response = await fetch(target.toString(), { headers: { Accept: "application/json", apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, [UPSTREAM_AUTH_HEADER]: upstreamSecret } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") throw new Error("station_series_ingest_failed");
  return payload;
}

async function fetchR2AqiHead(request, bounds, env) {
  const baseUrl = required(env.UK_AQ_AQI_HISTORY_R2_API_URL);
  const upstreamSecret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !upstreamSecret) throw new Error("station_series_r2_config_missing");
  const target = new URL(baseUrl);
  target.searchParams.set("scope", "timeseries");
  target.searchParams.set("grain", "hourly");
  target.searchParams.set("timeseries_id", String(request.timeseriesId));
  target.searchParams.set("connector_id", String(request.connectorId));
  target.searchParams.set("pollutant", request.pollutant);
  target.searchParams.set("start_utc", new Date(bounds.headStartMs).toISOString());
  target.searchParams.set("end_utc", new Date(bounds.headEndMs).toISOString());
  target.searchParams.set("row_limit", String(STABLE_HEAD_MAX_HOURS));
  target.searchParams.set("format", "objects");
  const response = await fetch(target.toString(), { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: upstreamSecret } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") throw new Error("station_series_r2_aqi_failed");
  if (r2CoverageClaimsComplete(payload) && !r2ResponseComplete(payload)) throw new Error("station_series_r2_claimed_complete_response_incomplete");
  return payload;
}

async function buildLongStationSeries(request, env) {
  const bounds = resolveStableHeadBounds(request);
  const r2Payload = await fetchR2AqiHead(request, bounds, env);
  const r2Rows = normalizeExactR2AqiRows(r2Payload, request, bounds);
  const missingHours = missingHeadHours(r2Rows, bounds);
  let liveRows = [];
  let observationRows = [];
  let liveComplete = true;
  let ingestRowCount = 0;
  let requiredContextStartMs = bounds.headStartMs;
  let ingestFetchCount = 0;
  if (missingHours.length) {
    const firstMissingMs = Date.parse(missingHours[0]);
    const lastMissingEndMs = Date.parse(missingHours[missingHours.length - 1]) + HOUR_MS;
    requiredContextStartMs = firstMissingMs - request.contextHours * HOUR_MS;
    const liveRequest = { ...request, startMs: firstMissingMs, endMs: lastMissingEndMs, contextStartMs: requiredContextStartMs };
    const ingestPayload = await fetchIngestOnce(liveRequest, env);
    ingestFetchCount = 1;
    const liveBundle = buildStationSeriesFromIngest(liveRequest, ingestPayload);
    const eligibleMissing = new Set(missingHours);
    liveRows = liveBundle.aqi.rows.filter((row) => eligibleMissing.has(row.timestamp_hour_utc));
    observationRows = liveBundle.observations.rows;
    liveComplete = liveBundle.source.ingest_response_complete
      && missingHours.every((hour) => liveRows.some((row) => row.timestamp_hour_utc === hour));
    ingestRowCount = liveBundle.source.ingest_row_count;
  }
  const merged = mergeStableAqiHead({ r2Rows, liveRows, request, bounds });
  const headHours = outputHours(bounds.headStartMs, bounds.headEndMs);
  const mergedHours = new Set(merged.rows.map((row) => row.timestamp_hour_utc));
  const remainingMissing = headHours.filter((hour) => !mergedHours.has(new Date(hour).toISOString())).map((hour) => new Date(hour).toISOString());
  const complete = liveComplete && remainingMissing.length === 0;
  const headStartUtc = new Date(bounds.headStartMs).toISOString();
  const headEndUtc = new Date(bounds.headEndMs).toISOString();
  console.log(JSON.stringify({
    event: "station_series_stable_head_merge",
    timeseries_id: request.timeseriesId,
    connector_id: request.connectorId,
    pollutant: request.pollutant,
    head_start_utc: headStartUtc,
    head_end_utc: headEndUtc,
    r2_row_count: r2Rows.length,
    live_calculated_row_count: liveRows.length,
    overlap_count: merged.overlap_count,
    mismatch_count: merged.mismatch_count,
    mismatch_hours: merged.mismatch_hours,
    response_complete: complete,
  }));
  return {
    schema_version: 1,
    request: { timeseries_id: request.timeseriesId, connector_id: request.connectorId, pollutant: request.pollutant, start_utc: new Date(request.startMs).toISOString(), end_utc: new Date(request.endMs).toISOString(), window: request.window, format: "objects" },
    source: { mode: complete ? "stable_r2_live_head" : "stable_head_incomplete", required_context_start_utc: new Date(requiredContextStartMs).toISOString(), output_start_utc: headStartUtc, output_end_utc: headEndUtc, ingest_response_complete: liveComplete, r2_response_complete: r2ResponseComplete(r2Payload), used_recent_r2_aqi: true, used_r2_observations: false, ingest_row_count: ingestRowCount, ingest_fetch_count: ingestFetchCount, r2_aqi_fetch_count: 1 },
    aqi: {
      rows: merged.rows,
      response_complete: complete,
      has_gap: !complete,
      gap_ranges: remainingMissing.map((hour) => ({ start_utc: hour, end_utc: new Date(Date.parse(hour) + HOUR_MS).toISOString() })),
      stable_head_start_utc: headStartUtc,
      stable_head_end_utc: headEndUtc,
      next_chunk_end_utc: headStartUtc,
      next_older_aqi_chunk_end_utc: headStartUtc,
      stable_head_locked: complete,
      replacement_policy: "extend_backwards_only",
      source_counts: { r2: r2Rows.length, live_calculated: liveRows.length },
      overlap_count: merged.overlap_count,
      mismatch_count: merged.mismatch_count,
      mismatch_hours: merged.mismatch_hours,
    },
    observations: { rows: observationRows, response_complete: liveComplete, has_gap: !liveComplete, gap_ranges: [], next_chunk_end_utc: headStartUtc, source_counts: { ingest: observationRows.length } },
  };
}

async function fetchJsonUpstream(target, secret, failureCode) {
  try {
    const response = await fetch(target.toString(), { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") throw new Error(failureCode);
    return payload;
  } catch (error) {
    throw new Error(error instanceof Error && error.message === failureCode ? failureCode : failureCode);
  }
}

function chunkHeaders(body) {
  const complete = body.response_complete === true;
  const immutable = body.chunk.cache_class === "immutable";
  return headersFor({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": complete ? (immutable ? "public, max-age=86400, s-maxage=86400" : "public, max-age=300, s-maxage=300") : "no-store",
    "X-UK-AQ-Chunk-Direction": body.chunk.direction,
    "X-UK-AQ-Chunk-Start": body.chunk.start_utc,
    "X-UK-AQ-Chunk-End": body.chunk.end_utc,
    "X-UK-AQ-Next-Older-Chunk-End": body.chunk.next_older_chunk_end_utc,
    "X-UK-AQ-Chunk-Cache-Class": body.chunk.cache_class,
    "X-UK-AQ-Chunk-Retry-Key": body.chunk.retry_key,
    "X-UK-AQ-Response-Complete": String(complete),
  });
}

async function handleAqiHistoryChunk(request, env) {
  const url = new URL(request.url);
  const chunk = parseHistoryChunkRequest(url, "aqi");
  if (!chunk.ok) return errorResponse(chunk.code === "history_chunk_overlaps_stable_head" ? 409 : 400, chunk.code, url.pathname);
  const baseUrl = required(env.UK_AQ_AQI_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) return errorResponse(500, "internal_aqi_history_config_missing", url.pathname);
  const target = new URL(baseUrl);
  target.search = "";
  target.searchParams.set("scope", "timeseries");
  target.searchParams.set("grain", "hourly");
  target.searchParams.set("timeseries_id", String(chunk.timeseriesId));
  target.searchParams.set("connector_id", String(chunk.connectorId));
  target.searchParams.set("pollutant", chunk.pollutant);
  target.searchParams.set("start_utc", chunk.startUtc);
  target.searchParams.set("end_utc", chunk.endUtc);
  target.searchParams.set("row_limit", String(chunk.limit));
  target.searchParams.set("format", "objects");
  try {
    const payload = await fetchJsonUpstream(target, secret, "aqi_history_r2_failed");
    const body = buildAqiHistoryChunk(chunk, payload);
    const formatted = aqiResponseRows(body, chunk.format);
    body.columns = formatted.columns;
    body.points = formatted.points;
    const headers = chunkHeaders(body);
    if (chunk.format === "tsv") {
      headers.set("Content-Type", "text/tab-separated-values; charset=utf-8");
      return new Response(buildTsv(formatted.columns, formatted.points), { status: 200, headers });
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch (error) {
    return errorResponse(502, error instanceof Error ? error.message : "aqi_history_r2_failed", url.pathname);
  }
}

async function handleObservationHistoryChunk(request, env) {
  const url = new URL(request.url);
  const chunk = parseHistoryChunkRequest(url, "observations");
  if (!chunk.ok) return errorResponse(chunk.code === "history_chunk_overlaps_stable_head" ? 409 : 400, chunk.code, url.pathname);
  const baseUrl = required(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) return errorResponse(500, "internal_observation_history_config_missing", url.pathname);
  const target = new URL(baseUrl);
  if (!target.pathname || target.pathname === "/") target.pathname = "/v1/observations";
  target.search = "";
  target.searchParams.set("timeseries_id", String(chunk.timeseriesId));
  target.searchParams.set("connector_id", String(chunk.connectorId));
  target.searchParams.set("pollutant", chunk.pollutant);
  target.searchParams.set("start_utc", chunk.startUtc);
  target.searchParams.set("end_utc", chunk.endUtc);
  target.searchParams.set("limit", String(chunk.limit));
  try {
    const payload = await fetchJsonUpstream(target, secret, "observation_history_r2_failed");
    const body = buildObservationHistoryChunk(chunk, payload);
    return new Response(JSON.stringify(body), { status: 200, headers: chunkHeaders(body) });
  } catch (error) {
    return errorResponse(502, error instanceof Error ? error.message : "observation_history_r2_failed", url.pathname);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return errorResponse(405, "internal_method_not_allowed", url.pathname);
    if (url.pathname === "/v1/aqi-history") return handleAqiHistoryChunk(request, env);
    if (url.pathname === "/v1/observations-history") return handleObservationHistoryChunk(request, env);
    if (url.pathname !== "/v1/station-series") return errorResponse(404, "internal_route_not_found", url.pathname);
    if (String(url.searchParams.get("format") ?? "").toLowerCase() !== "objects") return errorResponse(400, "station_series_format_objects_required", url.pathname);
    const stationRequest = resolveStationSeriesRequest(url);
    if (!stationRequest) return errorResponse(400, "station_series_request_invalid", url.pathname);
    try {
      const shortWindow = stationRequest.window === "12h" || stationRequest.window === "24h";
      const body = shortWindow
        ? buildStationSeriesFromIngest(stationRequest, await fetchIngestOnce(stationRequest, env))
        : await buildLongStationSeries(stationRequest, env);
      const complete = body.aqi.response_complete && body.observations.response_complete;
      return new Response(JSON.stringify(body), { status: 200, headers: headersFor({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": complete ? "public, max-age=60, s-maxage=60" : "no-store", "X-UK-AQ-Station-History-Source-Mode": body.source.mode, "X-UK-AQ-Station-History-Ingest-Fetches": String(body.source.ingest_fetch_count) }) });
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "station_series_failed", url.pathname);
    }
  },
};

export { CONTRACT_VERSION, errorResponse };
