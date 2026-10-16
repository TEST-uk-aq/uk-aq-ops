import {
  AQI_ALGORITHM_VERSION,
  DAQI_PM_ROLLING24H_REQUIRED_HOURS,
  DAQI_PM_ROLLING24H_WINDOW_HOURS,
  computeRolling24h,
  helperRowToNormalizedAqiV1Row,
} from "../../../lib/aqi/aqi_levels.mjs";
import { resolveAuthoritativeTimeseriesIdentity } from "./identity.mjs";
import { readRecentRows } from "./recent_aqi_prototype.mjs";

const ROUTE = "/v1/recent-hourly-prototype";
const HOUR_MS = 3_600_000;
const OUTPUT_HOURS = 6;
const UPSTREAM_TIMEOUT_MS = 2_500;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_OUTPUT_BYTES = 48 * 1024;
const POLLUTANTS = new Set(["pm25", "pm10", "no2"]);

function reply(status, body) {
  const json = JSON.stringify(body);
  if (new TextEncoder().encode(json).byteLength > MAX_OUTPUT_BYTES) return fail(413, "output_response_too_large");
  return new Response(json, { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-UK-AQ-Prototype-Route": "recent-hourly-ingestdb",
  } });
}

function fail(status, code) {
  return reply(status, { ok: false, error: { code, route: ROUTE } });
}

function positiveId(value) {
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
}

function approvedTimeseries(env) {
  const approved = new Map();
  const legacy = String(env.UK_AQ_RECENT_AQI_PROTOTYPE_TIMESERIES_ID || "").trim();
  if (legacy) {
    if (!positiveId(legacy)) throw new Error("prototype_allowlist_unavailable");
    approved.set(Number(legacy), { timeseries_id: Number(legacy), connector_id: 1, pollutant: "pm25" });
  }
  const text = String(env.UK_AQ_RECENT_HOURLY_PROTOTYPE_ALLOWLIST || "").trim();
  if (text) {
    if (text.length > 4096) throw new Error("prototype_allowlist_unavailable");
    let entries;
    try { entries = JSON.parse(text); } catch { throw new Error("prototype_allowlist_unavailable"); }
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 16) throw new Error("prototype_allowlist_unavailable");
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || Object.keys(entry).length !== 3 || typeof entry.timeseries_id !== "number"
        || !positiveId(entry.timeseries_id) || entry.connector_id !== 1 || !POLLUTANTS.has(entry.pollutant)
        || seen.has(entry.timeseries_id)) throw new Error("prototype_allowlist_unavailable");
      seen.add(entry.timeseries_id);
      const previous = approved.get(entry.timeseries_id);
      if (previous && previous.pollutant !== entry.pollutant) throw new Error("prototype_allowlist_unavailable");
      approved.set(entry.timeseries_id, entry);
    }
  }
  if (!approved.size) throw new Error("prototype_allowlist_unavailable");
  return approved;
}

function parseRequest(url, approved, nowMs) {
  if (url.search.length > 256 || url.searchParams.size !== 2) return null;
  for (const key of url.searchParams.keys()) if (key !== "timeseries_id" && key !== "pollutant") return null;
  const id = url.searchParams.get("timeseries_id");
  const entry = positiveId(id) ? approved.get(Number(id)) : null;
  if (!entry || url.searchParams.get("pollutant") !== entry.pollutant) return null;
  return {
    timeseriesId: entry.timeseries_id, connectorId: entry.connector_id, pollutant: entry.pollutant,
    requestedAtMs: nowMs, latestCompletedHourMs: Math.floor(nowMs / HOUR_MS) * HOUR_MS,
  };
}

const iso = (ms) => new Date(ms).toISOString();

function calculate(identity, request, source, contextHours) {
  const hours = new Map();
  let endpointMs = null;
  let latestSourceMs = null;
  let futureRows = 0;
  let allValidRows = 0;
  let allInvalidRows = 0;
  // Parse source timestamps once; preserve multiplicity instead of deduplicating.
  for (const raw of source.rows) {
    const timestamp = Date.parse(String(raw?.observed_at ?? ""));
    if (!Number.isFinite(timestamp)) throw new Error("source_timestamp_invalid");
    if (timestamp <= source.requestedSinceMs || timestamp < source.rpcWindowStartMs) throw new Error("source_query_bounds_unverified");
    if (timestamp > request.latestCompletedHourMs) { futureRows += 1; continue; }
    if (timestamp % HOUR_MS !== 0) throw new Error("source_timestamp_convention_unverified");
    const numeric = typeof raw.value === "number" || (typeof raw.value === "string" && raw.value.trim() !== "");
    const value = numeric ? Number(raw.value) : NaN;
    const valid = Number.isFinite(value) && value >= 0;
    const group = hours.get(timestamp) || { sum: 0, count: 0, invalid: 0, rows: [] };
    if (valid) { group.sum += value; group.count += 1; allValidRows += 1; }
    else { group.invalid += 1; allInvalidRows += 1; }
    if (!Number.isFinite(group.sum)) throw new Error("source_value_aggregate_invalid");
    group.rows.push({ observed_at: raw.observed_at, value: Number.isFinite(value) ? value : null, status: valid ? "valid" : "invalid" });
    hours.set(timestamp, group);
    if (latestSourceMs === null || timestamp > latestSourceMs) latestSourceMs = timestamp;
    if (valid && (endpointMs === null || timestamp > endpointMs)) endpointMs = timestamp;
  }
  if (endpointMs === null) {
    if (source.metadataAnchorMs < source.rpcWindowStartMs) throw new Error("source_window_limit_exceeded");
    throw new Error("no_valid_source_observation");
  }
  const contextStartMs = endpointMs - contextHours * HOUR_MS;
  if (contextStartMs < source.rpcWindowStartMs) throw new Error("source_window_limit_exceeded");
  if (contextStartMs < source.requestedSinceMs) throw new Error("source_context_outside_metadata_anchor");

  const helperRows = [];
  const missingContext = [];
  let validRows = 0;
  let invalidRows = 0;
  let validHours = 0;
  // A bounded chronological grid keeps gaps explicit and avoids source sorting.
  for (let timestamp = contextStartMs + HOUR_MS; timestamp <= endpointMs; timestamp += HOUR_MS) {
    const group = hours.get(timestamp);
    const count = group?.count || 0;
    validRows += count;
    invalidRows += group?.invalid || 0;
    if (count) validHours += 1;
    else missingContext.push(iso(timestamp));
    helperRows.push({
      connector_id: identity.connectorId, station_id: identity.stationId, timeseries_id: identity.timeseriesId,
      pollutant_code: request.pollutant, timestamp_hour_utc: iso(timestamp),
      [`${request.pollutant}_hourly_mean_ugm3`]: count ? group.sum / count : null,
      hourly_sample_count: count,
    });
  }
  const pm = request.pollutant !== "no2";
  if (pm) computeRolling24h(helperRows);
  const observations = [];
  const aqiRows = [];
  const missingOutput = [];
  for (let index = helperRows.length - OUTPUT_HOURS; index < helperRows.length; index += 1) {
    const helper = helperRows[index];
    const timestamp = contextStartMs + (index + 1) * HOUR_MS;
    const group = hours.get(timestamp);
    const aqi = helperRowToNormalizedAqiV1Row(helper, { computedAtUtc: null });
    // The shared helper labels a wholly empty PM window missing_input; the
    // active contract requires insufficient_samples for every <18-hour window.
    if (pm && aqi.daqi_source_observation_count === null) {
      aqi.daqi_source_observation_count = 0;
      aqi.daqi_calculation_status = "insufficient_samples";
      aqi.daqi_missing_reason = "insufficient_rolling_24h_hours";
    }
    const status = group?.count ? "valid" : group ? "invalid" : "missing";
    if (status !== "valid") missingOutput.push(helper.timestamp_hour_utc);
    const interval = { timestamp_hour_utc: helper.timestamp_hour_utc, period_start_utc: iso(timestamp - HOUR_MS), period_end_utc: helper.timestamp_hour_utc };
    observations.push({
      ...interval, connector_id: identity.connectorId, station_id: identity.stationId, timeseries_id: identity.timeseriesId,
      pollutant: request.pollutant, status, hourly_mean_ugm3: aqi.hourly_mean_ugm3,
      valid_source_row_count: group?.count || 0, invalid_source_row_count: group?.invalid || 0,
      source_observations: group?.rows || [],
    });
    aqiRows.push({
      ...interval,
      connector_id: identity.connectorId, station_id: identity.stationId,
      timeseries_id: identity.timeseriesId, pollutant_code: identity.pollutant,
      daqi_index_level: aqi.daqi_index_level, daqi_input_value_ugm3: aqi.daqi_input_value_ugm3,
      daqi_source_observation_count: aqi.daqi_source_observation_count,
      daqi_required_observation_count: aqi.daqi_required_observation_count,
      daqi_calculation_status: aqi.daqi_calculation_status, daqi_missing_reason: aqi.daqi_missing_reason,
      eaqi_index_level: aqi.eaqi_index_level, eaqi_input_value_ugm3: aqi.eaqi_input_value_ugm3,
      eaqi_source_observation_count: aqi.eaqi_source_observation_count,
      eaqi_required_observation_count: aqi.eaqi_required_observation_count,
      eaqi_calculation_status: aqi.eaqi_calculation_status, eaqi_missing_reason: aqi.eaqi_missing_reason,
    });
  }
  return { endpointMs, latestSourceMs, hours, observations, aqiRows, missingContext, missingOutput,
    contextStartMs, validRows, invalidRows, validHours, allValidRows, allInvalidRows, futureRows };
}

export async function handleRecentHourlyPrototype(request, env) {
  if (env.UK_AQ_ENV_NAME !== "TEST" || env.UK_AQ_RECENT_AQI_PROTOTYPE_ENABLED !== "true") return fail(404, "prototype_disabled");
  if (request.method !== "GET") return fail(405, "method_not_allowed");
  const startedMs = Date.now();
  const remaining = () => {
    const elapsed = Date.now() - startedMs;
    if (elapsed >= REQUEST_TIMEOUT_MS) throw new Error("prototype_request_timeout");
    return Math.min(UPSTREAM_TIMEOUT_MS, REQUEST_TIMEOUT_MS - elapsed);
  };
  try {
    const parsed = parseRequest(new URL(request.url), approvedTimeseries(env), startedMs);
    if (!parsed) return fail(400, "prototype_request_invalid_or_unauthorised");
    const identity = await resolveAuthoritativeTimeseriesIdentity(parsed, env, {
      timeoutMs: remaining(), maxResponseBytes: 8 * 1024, includeLastValueAt: true,
    });
    if (identity.timeseriesId !== parsed.timeseriesId || identity.connectorId !== parsed.connectorId
      || identity.pollutant !== parsed.pollutant) return fail(409, "prototype_identity_mismatch");
    const pm = parsed.pollutant !== "no2";
    const contextHours = OUTPUT_HOURS + (pm ? DAQI_PM_ROLLING24H_WINDOW_HOURS - 1 : 0);
    const source = await readRecentRows(env, identity.timeseriesId, identity.lastValueAt, remaining(), contextHours);
    remaining();
    const result = calculate(identity, parsed, source, contextHours);
    remaining();
    const endpoint = iso(result.endpointMs);
    return reply(200, {
      schema_version: "recent_hourly_prototype_v1",
      request: {
        timeseries_id: identity.timeseriesId, connector_id: identity.connectorId, station_id: identity.stationId,
        pollutant: identity.pollutant, requested_at_utc: iso(startedMs),
      },
      selection: {
        calculation_endpoint_utc: endpoint,
        latest_source_observation_timestamp_utc: iso(result.latestSourceMs),
        latest_source_observation_has_valid_value: Boolean(result.hours.get(result.latestSourceMs)?.count),
        selected_endpoint_precedes_latest_source_observation: result.latestSourceMs > result.endpointMs,
        selected_observation_age_minutes: Number(((startedMs - result.endpointMs) / 60_000).toFixed(2)),
        latest_completed_clock_hour_utc: iso(parsed.latestCompletedHourMs),
        output_start_exclusive_utc: iso(result.endpointMs - OUTPUT_HOURS * HOUR_MS), output_end_inclusive_utc: endpoint,
        output_first_endpoint_utc: iso(result.endpointMs - (OUTPUT_HOURS - 1) * HOUR_MS), output_hour_count: OUTPUT_HOURS,
        metadata_anchor_last_value_at_utc: identity.lastValueAt,
      },
      observations: { has_gap: result.missingOutput.length > 0, missing_hour_endpoints_utc: result.missingOutput, rows: result.observations },
      aqi: {
        algorithm_version: AQI_ALGORITHM_VERSION, source: "live_calculated_ingestdb_only",
        daqi_input_averaging_code: pm ? "rolling_24h_mean" : "hourly_mean", eaqi_input_averaging_code: "hourly_mean",
        daqi_required_observation_count: pm ? DAQI_PM_ROLLING24H_REQUIRED_HOURS : 1,
        has_gap: result.aqiRows.some((row) => row.daqi_calculation_status !== "ok" || row.eaqi_calculation_status !== "ok"),
        response_complete: false, partial_reasons: ["canonical_r2_not_read"], rows: result.aqiRows,
      },
      source: {
        mode: "ingestdb_only_uncommitted", source_path: `${String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public")}.uk_aq_timeseries_rpc`,
        transport_ok: true, bounded_query_complete: true, ingestdb_response_complete: true,
        canonical_history_complete: false, response_complete: false, partial_reasons: ["canonical_r2_not_read"],
        canonical_history_limitation: "Canonical R2 history and precedence were not verified; gaps describe this bounded IngestDB read only.",
        requested_since_exclusive_utc: iso(source.requestedSinceMs), rpc_window_start_utc: iso(source.rpcWindowStartMs),
        context_start_exclusive_utc: iso(result.contextStartMs), context_end_inclusive_utc: endpoint,
        required_context_hour_count: contextHours, context_query_bounds_verified: true,
        valid_context_hour_count: result.validHours, missing_context_hour_endpoints_utc: result.missingContext,
        raw_row_count: source.rows.length, valid_input_row_count: result.allValidRows, invalid_input_row_count: result.allInvalidRows,
        valid_context_row_count: result.validRows, invalid_context_row_count: result.invalidRows,
        excluded_future_row_count: result.futureRows,
        outside_context_row_count: source.rows.length - result.validRows - result.invalidRows - result.futureRows,
        max_input_rows: 128, input_response_bytes: source.bytes, rpc_elapsed_ms: source.rpcElapsedMs,
        identity_lookup_count: 1, observation_rpc_count: 1,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "prototype_failed";
    const statusByCode = {
      prototype_allowlist_unavailable: 503, prototype_request_timeout: 504,
      response_too_large: 413, response_missing: 502, output_response_too_large: 413,
      source_config_missing: 503, source_metadata_anchor_unavailable: 503, source_http_failed: 502,
      source_coverage_unverified: 502, source_query_bounds_unverified: 502, input_row_limit_exceeded: 413,
      source_timestamp_invalid: 502, source_timestamp_convention_unverified: 502, source_value_aggregate_invalid: 502,
      source_window_limit_exceeded: 422, source_context_outside_metadata_anchor: 422, no_valid_source_observation: 404,
    };
    // Never expose upstream bodies, arbitrary exception text or credentials.
    const status = Object.hasOwn(statusByCode, code) ? statusByCode[code] : 502;
    return fail(status, Object.hasOwn(statusByCode, code) ? code : "prototype_upstream_or_identity_failed");
  }
}
