import {
  AQI_ALGORITHM_VERSION,
  helperRowsToNormalizedAqiV1Rows,
  pivotNarrowRowsToHelperRows,
  sourceObservationsToNarrowRows,
} from "../../../lib/aqi/aqi_levels.mjs";
import { readR2Observations } from "./r2_observations.mjs";
import { publicContinuity, selectContinuitySegments } from "./continuity.mjs";

const HOUR_MS = 60 * 60 * 1000;

function hourEndpoints(startMs, endMs) {
  const endpoints = [];
  let cursor = Math.floor(startMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (; cursor <= endMs; cursor += HOUR_MS) endpoints.push(cursor);
  return endpoints;
}

function identityForSegment(segment) {
  return { timeseriesId: segment.timeseriesId, connectorId: segment.connectorId, stationId: segment.stationId, pollutant: segment.pollutant };
}

function memberAt(continuity, timestampMs) {
  const selected = selectContinuitySegments(continuity, timestampMs, timestampMs + 1).segments;
  return selected.length === 1 ? selected[0] : null;
}

function mergePhysicalObservations(r2Rows, ingestRows, continuity) {
  const rows = new Map();
  for (const source of [ingestRows, r2Rows]) {
    for (const row of Array.isArray(source) ? source : []) {
      const timestamp = Date.parse(String(row?.observed_at || ""));
      const value = Number(row?.value);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value < 0) continue;
      const member = memberAt(continuity, timestamp);
      if (!member) continue;
      const normalized = {
        ...row,
        connector_id: member.connectorId,
        station_id: member.stationId,
        timeseries_id: member.timeseriesId,
        pollutant_code: member.pollutant,
        observed_at: new Date(timestamp).toISOString(),
        value,
      };
      const existing = rows.get(normalized.observed_at);
      if (existing && (existing.timeseries_id !== normalized.timeseries_id || existing.value !== normalized.value)) throw new Error("station_history_continuity_observation_conflict");
      if (!existing || normalized.source === "r2") rows.set(normalized.observed_at, normalized);
    }
  }
  return [...rows.values()].sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

function calculateLogicalAqi(observationRows, request, continuity, outputStartMs, outputEndMs) {
  const logicalRows = observationRows.map((row) => ({
    ...row,
    station_id: request.stationId,
    timeseries_id: request.timeseriesId,
  }));
  return helperRowsToNormalizedAqiV1Rows(
    pivotNarrowRowsToHelperRows(
      sourceObservationsToNarrowRows(logicalRows),
      {
        rangeStartUtc: new Date(outputStartMs + HOUR_MS).toISOString(),
        rangeEndUtc: new Date(outputEndMs + HOUR_MS).toISOString(),
      },
    ),
    { computedAtUtc: null },
  ).filter((row) => {
    const endpoint = Date.parse(row.timestamp_hour_utc);
    return endpoint > outputStartMs && endpoint <= outputEndMs;
  }).map((row) => {
    const endpoint = Date.parse(row.timestamp_hour_utc);
    // AQI timestamps are hour-ending endpoints.  Attribute the interval to
    // the physical member that supplied the observation immediately before
    // that endpoint, including at a midnight continuity boundary.
    const physical = memberAt(continuity, endpoint - 1);
    if (!physical) throw new Error("station_history_continuity_aqi_identity_missing");
    return {
      ...row,
      connector_id: physical.connectorId,
      station_id: physical.stationId,
      timeseries_id: physical.timeseriesId,
      period_start_utc: new Date(endpoint - HOUR_MS).toISOString(),
      period_end_utc: new Date(endpoint).toISOString(),
      timestamp_hour_utc: new Date(endpoint).toISOString(),
      source: "calculated_from_observations",
    };
  });
}

function missingRanges(expected, present) {
  return expected.filter((timestamp) => !present.has(timestamp)).map((timestamp) => ({
    start_utc: new Date(timestamp - HOUR_MS).toISOString(),
    end_utc: new Date(timestamp).toISOString(),
  }));
}

export async function buildCalculatedHistory({ request, continuity, env, outputStartMs, outputEndMs, ingestRows = [], ingestComplete = false, ingestFetchCount = 0, guideline = null } = {}) {
  const includeObservations = request.includeObservations !== false;
  const contextHours = request.includeAqi && ["pm25", "pm10"].includes(request.pollutant) ? 23 : 0;
  const requiredStartMs = outputStartMs - contextHours * HOUR_MS;
  const requiredEndExclusiveMs = outputEndMs + 1;
  const selection = selectContinuitySegments(continuity, requiredStartMs, requiredEndExclusiveMs);
  const visibleSelection = selectContinuitySegments(continuity, outputStartMs, requiredEndExclusiveMs);
  if (!selection.segments.length) throw new Error("station_history_continuity_member_missing");
  const reads = await Promise.all(selection.segments.map(async (segment) => ({
    segment,
    result: await readR2Observations({ env, identity: identityForSegment(segment), startMs: segment.startMs, endMs: segment.endMs }),
  })));
  const r2Rows = reads.flatMap((entry) => entry.result.rows);
  const rows = mergePhysicalObservations(r2Rows, ingestRows, continuity);
  const visibleRows = rows.filter((row) => {
    const timestamp = Date.parse(row.observed_at);
    return timestamp >= outputStartMs && timestamp <= outputEndMs;
  });
  const aqiRows = request.includeAqi ? calculateLogicalAqi(rows, request, continuity, outputStartMs, outputEndMs) : [];
  const expected = hourEndpoints(outputStartMs, outputEndMs);
  const observationPresent = new Set(visibleRows.map((row) => Date.parse(row.observed_at)).filter(Number.isFinite));
  const aqiPresent = new Set(aqiRows.map((row) => Date.parse(row.timestamp_hour_utc)).filter(Number.isFinite));
  // Hidden PM context affects AQI only.  A continuity gap before the visible
  // range must never make an otherwise complete observation response partial.
  const observationGaps = includeObservations
    ? [...visibleSelection.gaps, ...missingRanges(expected, observationPresent)]
    : [];
  const aqiGaps = request.includeAqi
    ? [...visibleSelection.gaps, ...missingRanges(expected, aqiPresent)]
    : [];
  const r2Complete = reads.every((entry) => entry.result.response_complete === true);
  const sourceComplete = r2Complete || ingestComplete === true;
  const observationsComplete = includeObservations && sourceComplete && observationGaps.length === 0;
  const aqiStatusesComplete = !request.includeAqi || aqiRows.every((row) => row.daqi_calculation_status === "ok" && row.eaqi_calculation_status === "ok");
  const aqiContextComplete = selection.gaps.length === 0;
  const aqiComplete = request.includeAqi && sourceComplete && aqiContextComplete && aqiGaps.length === 0 && aqiStatusesComplete;
  const observationPartialReasons = observationsComplete ? [] : Array.from(new Set([
    ...(sourceComplete ? [] : ["required_observation_source_incomplete"]),
    ...(observationGaps.length ? ["missing_visible_observation_hours"] : []),
  ]));
  const aqiPartialReasons = aqiComplete ? [] : Array.from(new Set([
    ...(sourceComplete ? [] : ["required_observation_source_incomplete"]),
    ...(aqiContextComplete ? [] : ["required_aqi_context_incomplete"]),
    ...(aqiGaps.length ? ["missing_visible_aqi_hours"] : []),
    ...(aqiStatusesComplete ? [] : ["calculated_aqi_status_incomplete"]),
  ]));
  const sourceSegments = reads.map(({ segment, result }) => ({
    station_id: segment.stationId,
    timeseries_id: segment.timeseriesId,
    start_utc: new Date(segment.startMs).toISOString(),
    end_utc: new Date(segment.endMs).toISOString(),
    response_complete: result.response_complete === true,
    row_count: result.rows.length,
  }));
  return {
    schema_version: 2,
    request: {
      connector_id: request.connectorId,
      requested_timeseries_id: request.timeseriesId,
      station_id: request.stationId,
      pollutant: request.pollutant,
      start_utc: new Date(outputStartMs).toISOString(),
      end_utc: new Date(outputEndMs).toISOString(),
      include_observations: includeObservations,
      include_aqi: request.includeAqi,
    },
    continuity: publicContinuity(continuity),
    observations: {
      enabled: includeObservations,
      rows: includeObservations ? visibleRows : [],
      guideline,
      response_complete: observationsComplete,
      has_gap: observationGaps.length > 0,
      gap_ranges: observationGaps,
      partial_reasons: includeObservations ? observationPartialReasons : [],
      source_segments: sourceSegments,
      source_counts: { r2: visibleRows.filter((row) => row.source === "r2").length, ingest: visibleRows.filter((row) => row.source === "ingest").length },
    },
    aqi: request.includeAqi ? {
      enabled: true,
      calculation_source: "calculated_from_observations",
      response_contract: "aqi_hour_interval_v2",
      algorithm_version: AQI_ALGORITHM_VERSION,
      rows: aqiRows,
      response_complete: aqiComplete,
      has_gap: aqiGaps.length > 0 || !aqiStatusesComplete,
      gap_ranges: aqiGaps,
      partial_reasons: aqiPartialReasons,
      required_context_start_utc: new Date(requiredStartMs).toISOString(),
      output_start_utc: new Date(outputStartMs).toISOString(),
      output_end_utc: new Date(outputEndMs).toISOString(),
      source_counts: { calculated_from_observations: aqiRows.length },
    } : { enabled: false, calculation_source: null, rows: [], response_complete: false, has_gap: false, gap_ranges: [], partial_reasons: [] },
    source: {
      mode: "continuity_calculated_observations",
      ingest_fetch_count: ingestFetchCount,
      r2_observation_fetch_count: reads.length,
      required_context_start_utc: new Date(requiredStartMs).toISOString(),
      output_start_utc: new Date(outputStartMs).toISOString(),
      output_end_utc: new Date(outputEndMs).toISOString(),
    },
  };
}
