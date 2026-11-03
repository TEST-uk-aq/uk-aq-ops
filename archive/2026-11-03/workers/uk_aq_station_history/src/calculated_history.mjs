import {
  AQI_ALGORITHM_VERSION,
  helperRowsToNormalizedAqiV1Rows,
  mergeObservationRowsPreferR2,
  pivotNarrowRowsToHelperRows,
} from "../../../lib/aqi/aqi_levels.mjs";
import {
  createStationHistoryV3ReadBudget,
  readR2Observations,
  STATION_HISTORY_V3_OBSERVATION_ROW_BUDGET_REASON,
  STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON,
  usesV3PhysicalObservationPages,
} from "./r2_observations.mjs";
import { publicContinuity, selectContinuitySegments } from "./continuity.mjs";

const HOUR_MS = 60 * 60 * 1000;

function hourEndingEndpoint(timestampMs) {
  return Math.ceil(timestampMs / HOUR_MS) * HOUR_MS;
}

function hourEndpoints(startMs, endMs) {
  const endpoints = [];
  let cursor = Math.floor(startMs / HOUR_MS) * HOUR_MS + HOUR_MS;
  for (; cursor <= endMs; cursor += HOUR_MS) endpoints.push(cursor);
  return endpoints;
}

function identityForSegment(segment) {
  return { timeseriesId: segment.timeseriesId, connectorId: segment.connectorId, stationId: segment.stationId, pollutant: segment.pollutant };
}

function memberAt(segments, timestampMs) {
  // Selection was already validated and sorted for the complete context range.
  for (const segment of segments) {
    if (timestampMs < segment.startMs) break;
    if (timestampMs < segment.endMs) return segment;
  }
  return null;
}

function mergePhysicalObservations(r2Rows, ingestRows, segments, requiredStartMs, requiredEndExclusiveMs) {
  function prepare(source) {
    const prepared = [];
    const seen = new Map();
    for (const row of source) {
      const timestamp = Date.parse(String(row?.observed_at || ""));
      const value = Number(row?.value);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value) || value < 0
        || timestamp < requiredStartMs || timestamp >= requiredEndExclusiveMs) continue;
      const member = memberAt(segments, timestamp);
      if (!member) continue;
      if (Number(row.timeseries_id) !== member.timeseriesId
        || Number(row.station_id) !== member.stationId
        || Number(row.connector_id) !== member.connectorId
        || row.pollutant_code !== member.pollutant) {
        throw new Error("station_history_continuity_observation_conflict");
      }
      const observedAt = new Date(timestamp).toISOString();
      const key = `${member.timeseriesId}|${observedAt}`;
      const previous = seen.get(key);
      if (previous !== undefined && previous !== value) throw new Error("station_history_continuity_observation_conflict");
      seen.set(key, value);
      prepared.push(row.observed_at === observedAt && row.value === value
        ? row : { ...row, observed_at: observedAt, value });
    }
    return prepared;
  }
  const merged = mergeObservationRowsPreferR2({
    r2Rows: prepare(Array.isArray(r2Rows) ? r2Rows : []),
    ingestRows: prepare(Array.isArray(ingestRows) ? ingestRows : []),
  }).rows;
  const identityByTimestamp = new Map();
  for (const row of merged) {
    const previous = identityByTimestamp.get(row.observed_at);
    if (previous !== undefined && previous !== row.timeseries_id) throw new Error("station_history_continuity_observation_conflict");
    identityByTimestamp.set(row.observed_at, row.timeseries_id);
  }
  // The shared merge orders by physical timeseries first. The logical chart
  // stream must instead be chronological across continuity transitions.
  return merged.sort((left, right) => left.observed_at.localeCompare(right.observed_at)
    || left.timeseries_id - right.timeseries_id);
}

function sourceObservationsToHourEndingNarrowRows(rows, request, outputEndMs, expectedEndpoints) {
  const grouped = new Map();
  for (const row of rows) {
    const observedMs = Date.parse(row.observed_at);

    // Station-history AQI intervals are hour-ending. An observation exactly
    // on the hour keeps that timestamp as its endpoint; an observation inside
    // the hour belongs to the next clock-hour endpoint. This makes the bucket
    // represent (previous endpoint, endpoint] without collapsing raw readings.
    const endpointMs = hourEndingEndpoint(observedMs);
    if (endpointMs > outputEndMs) continue;
    const endpointIso = new Date(endpointMs).toISOString();
    const current = grouped.get(endpointMs) || {
      timeseries_id: request.timeseriesId,
      station_id: request.stationId,
      connector_id: request.connectorId,
      pollutant_code: request.pollutant,
      timestamp_hour_utc: endpointIso,
      sum: 0,
      count: 0,
    };
    current.sum += row.value;
    current.count += 1;
    grouped.set(endpointMs, current);
  }
  // A complete source read can legitimately have no observation in a visible
  // hour. Give the shared helper that hour so it evaluates a blank band (or a
  // valid PM rolling band) instead of leaving the endpoint unevaluated.
  for (const endpointMs of expectedEndpoints) {
    if (!grouped.has(endpointMs)) grouped.set(endpointMs, {
      timeseries_id: request.timeseriesId, station_id: request.stationId,
      connector_id: request.connectorId, pollutant_code: request.pollutant,
      timestamp_hour_utc: new Date(endpointMs).toISOString(), sum: 0, count: 0,
    });
  }
  return Array.from(grouped.values()).map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    connector_id: row.connector_id,
    timestamp_hour_utc: row.timestamp_hour_utc,
    pollutant_code: row.pollutant_code,
    hourly_mean_ugm3: row.count ? row.sum / row.count : null,
    sample_count: row.count || null,
  })).sort((left, right) => left.timestamp_hour_utc.localeCompare(right.timestamp_hour_utc));
}

function calculateLogicalAqi(observationRows, request, segments, outputStartMs, outputEndMs, expectedEndpoints) {
  return helperRowsToNormalizedAqiV1Rows(
    pivotNarrowRowsToHelperRows(
      sourceObservationsToHourEndingNarrowRows(observationRows, request, outputEndMs, expectedEndpoints),
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
    // The AQI row belongs to the physical member valid at its canonical
    // hour-ending timestamp, including at a midnight continuity boundary.
    const physical = memberAt(segments, endpoint);
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

export async function buildCalculatedHistory({ request, continuity, env, outputStartMs, outputEndMs, ingestRows = [], ingestComplete = false, ingestFetchCount = 0, guideline = null, observationReadBudget = null, observationProvider = null, ingestReader = null } = {}) {
  const includeObservations = request.includeObservations !== false;
  const contextHours = request.includeAqi && ["pm25", "pm10"].includes(request.pollutant) ? 23 : 0;
  const requiredStartMs = outputStartMs - contextHours * HOUR_MS;
  // Both parts include an observation exactly at the requested end. Readers
  // and continuity selection use exclusive end bounds.
  const requiredEndExclusiveMs = outputEndMs + 1;
  const selection = selectContinuitySegments(continuity, requiredStartMs, requiredEndExclusiveMs);
  const visibleSelection = selectContinuitySegments(continuity, outputStartMs, requiredEndExclusiveMs);
  if (!selection.segments.length) throw new Error("station_history_continuity_member_missing");
  let reads;
  if (observationProvider) {
    if (typeof observationProvider !== "function") throw new Error("station_history_observation_provider_invalid");
    reads = [];
    for (const segment of selection.segments) {
      const result = await observationProvider({
        identity: identityForSegment(segment),
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
      if (!result || !Array.isArray(result.rows) || typeof result.response_complete !== "boolean"
        || !Array.isArray(result.partial_reasons) || !Number.isSafeInteger(result.fetch_count)) {
        throw new Error("station_history_observation_provider_result_invalid");
      }
      reads.push({ segment, result });
    }
  } else if (usesV3PhysicalObservationPages(env)) {
    const readBudget = observationReadBudget || createStationHistoryV3ReadBudget();
    reads = [];
    for (const segment of selection.segments) {
      const result = await readR2Observations({
        env,
        identity: identityForSegment(segment),
        startMs: segment.startMs,
        endMs: segment.endMs,
        readBudget,
      });
      reads.push({ segment, result });
      if (result.partial_reasons.some((reason) => [
        STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON,
        STATION_HISTORY_V3_OBSERVATION_ROW_BUDGET_REASON,
      ].includes(reason))) break;
    }
  } else {
    reads = await Promise.all(selection.segments.map(async (segment) => ({
      segment,
      result: await readR2Observations({
        env,
        identity: identityForSegment(segment),
        startMs: segment.startMs,
        endMs: segment.endMs,
      }),
    })));
  }
  const r2Rows = reads.flatMap((entry) => entry.result.rows);
  let effectiveIngestRows = ingestRows;
  let effectiveIngestFetchCount = ingestFetchCount;
  let effectiveIngestComplete = ingestFetchCount === 0 || ingestComplete === true;
  if (ingestReader !== null) {
    if (typeof ingestReader !== "function") throw new Error("station_history_ingest_reader_invalid");
    const recovery = await ingestReader({ reads, requiredStartMs, requiredEndExclusiveMs });
    if (!recovery || !Array.isArray(recovery.rows) || typeof recovery.response_complete !== "boolean"
      || !Number.isSafeInteger(recovery.fetch_count) || recovery.fetch_count < 0) {
      throw new Error("station_history_ingest_recovery_result_invalid");
    }
    effectiveIngestRows = [...ingestRows, ...recovery.rows];
    effectiveIngestFetchCount += recovery.fetch_count;
    effectiveIngestComplete = effectiveIngestComplete && recovery.response_complete;
  }
  const rows = mergePhysicalObservations(r2Rows, effectiveIngestRows, selection.segments, requiredStartMs, requiredEndExclusiveMs);
  const visibleRows = [];
  const observationPresent = new Set();
  const sourceCounts = { r2: 0, ingest: 0, ...(observationProvider ? { json: 0 } : {}) };
  for (const row of rows) {
    const timestamp = Date.parse(row.observed_at);
    if (timestamp < outputStartMs || timestamp > outputEndMs) continue;
    visibleRows.push(row);
    observationPresent.add(hourEndingEndpoint(timestamp));
    if (Object.hasOwn(sourceCounts, row.source)) sourceCounts[row.source] += 1;
  }
  const expected = hourEndpoints(outputStartMs, outputEndMs);
  const aqiRows = request.includeAqi ? calculateLogicalAqi(rows, request, selection.segments, outputStartMs, outputEndMs, expected) : [];
  // Observation gaps use the same hour-ending convention as AQI:
  // exact-hour readings retain their endpoint; sub-hour readings use the next.
  const aqiPresent = new Set(aqiRows.map((row) => Date.parse(row.timestamp_hour_utc)));
  // Hidden PM context affects AQI only. A continuity gap before the visible
  // range must never make an otherwise complete observation response partial.
  const observationGaps = includeObservations
    ? [...visibleSelection.gaps, ...missingRanges(expected, observationPresent)]
    : [];
  const aqiGaps = request.includeAqi
    ? [...visibleSelection.gaps, ...missingRanges(expected, aqiPresent)]
    : [];
  const r2PartialReasons = [...new Set(reads.flatMap((entry) => entry.result.partial_reasons))];
  const readBudgetExceeded = r2PartialReasons.some((reason) => [
    STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON,
    STATION_HISTORY_V3_OBSERVATION_ROW_BUDGET_REASON,
  ].includes(reason));
  const r2Complete = reads.length === selection.segments.length
    && reads.every((entry) => entry.result.response_complete === true
      && entry.result.has_gap !== true && entry.result.partial_reasons.length === 0);
  // IngestDB can fill only timestamps proven absent from committed R2. A
  // completed ingest window cannot certify unread canonical pages or context.
  const sourceComplete = !readBudgetExceeded && r2Complete && effectiveIngestComplete;
  const observationsComplete = includeObservations && sourceComplete && visibleSelection.gaps.length === 0;
  const evaluatedStatus = (status, reason) => status === "ok"
    || (status === "insufficient_samples" && reason === "insufficient_rolling_24h_hours")
    || (status === "missing_input" && reason === "no_input_value");
  const aqiStatusesComplete = !request.includeAqi || aqiRows.every((row) =>
    evaluatedStatus(row.daqi_calculation_status, row.daqi_missing_reason)
    && evaluatedStatus(row.eaqi_calculation_status, row.eaqi_missing_reason));
  const aqiContextComplete = selection.gaps.length === 0
    && (!observationProvider || reads.every((entry) => entry.result.context_complete !== false));
  const aqiComplete = request.includeAqi && sourceComplete && aqiContextComplete
    && aqiPresent.size === expected.length && aqiStatusesComplete;
  const observationPartialReasons = observationsComplete ? [] : Array.from(new Set([
    ...r2PartialReasons,
    ...(sourceComplete ? [] : ["required_observation_source_incomplete"]),
    ...(observationGaps.length ? ["missing_visible_observation_hours"] : []),
  ]));
  const aqiPartialReasons = aqiComplete ? [] : Array.from(new Set([
    ...r2PartialReasons,
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
      source_counts: sourceCounts,
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
      mode: observationProvider ? "experimental_compressed_json_calculated_observations" : "continuity_calculated_observations",
      ingest_fetch_count: effectiveIngestFetchCount,
      r2_observation_fetch_count: observationProvider ? 0 : reads.reduce((sum, entry) => sum + entry.result.fetch_count, 0),
      ...(observationProvider ? { json_observation_fetch_count: reads.reduce((sum, entry) => sum + entry.result.fetch_count, 0) } : {}),
      required_context_start_utc: new Date(requiredStartMs).toISOString(),
      output_start_utc: new Date(outputStartMs).toISOString(),
      output_end_utc: new Date(outputEndMs).toISOString(),
    },
  };
}
