import {
  AQI_ALGORITHM_VERSION,
  computeRolling24h,
  helperRowToNormalizedAqiV1Row,
} from "../../../lib/aqi/aqi_levels.mjs";
import { resolveAuthoritativeTimeseriesIdentity } from "./identity.mjs";

const ROUTE = "/v1/recent-aqi-prototype";
const HOUR_MS = 3_600_000;
const MAX_INPUT_ROWS = 128;
const RPC_ROW_LIMIT = MAX_INPUT_ROWS + 1;
const MAX_RESPONSE_BYTES = 48 * 1024;
const UPSTREAM_TIMEOUT_MS = 2_500;
const REQUEST_TIMEOUT_MS = 4_000;
const RPC_WINDOW_LABEL = "30d";
const METADATA_BACKTRACK_MS = 24 * HOUR_MS;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-UK-AQ-Prototype-Route": "recent-aqi-ingestdb",
    },
  });
}

function fail(status, code) {
  return reply(status, { ok: false, error: { code, route: ROUTE } });
}

async function readBoundedJson(response) {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
  if (!response.body) throw new Error("response_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return { payload: JSON.parse(body), bytes };
}

function parseRequest(url, nowMs, allowedId) {
  if (url.search.length > 256 || url.searchParams.size !== 2) return null;
  if ([...url.searchParams.keys()].some((key) => !["timeseries_id", "pollutant"].includes(key))) return null;
  const idText = url.searchParams.get("timeseries_id");
  if (!/^[1-9]\d*$/.test(idText || "") || Number(idText) !== allowedId || url.searchParams.get("pollutant") !== "pm25") return null;
  return {
    timeseriesId: allowedId,
    connectorId: 1,
    pollutant: "pm25",
    requestedAtMs: nowMs,
    latestCompletedHourMs: Math.floor(nowMs / HOUR_MS) * HOUR_MS,
  };
}

export async function readRecentRows(env, timeseriesId, lastValueAt, timeoutMs, contextHours = 24) {
  const startedMs = Date.now();
  const base = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.SB_SECRET_KEY || "").trim();
  if (!base || !key) throw new Error("source_config_missing");
  const metadataAnchorMs = Date.parse(String(lastValueAt || ""));
  if (!Number.isFinite(metadataAnchorMs)) throw new Error("source_metadata_anchor_unavailable");
  const requestedSinceMs = metadataAnchorMs - contextHours * HOUR_MS - METADATA_BACKTRACK_MS;
  const target = new URL(`${base}/rest/v1/rpc/uk_aq_timeseries_rpc`);
  // last_value_at is only a query anchor. Include calculation context plus
  // up to 24 hours of selected-endpoint lag behind metadata. Source rows,
  // not the metadata value, select the actual endpoint.
  const response = await fetch(target, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Accept-Profile": String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public"),
      "Content-Profile": String(env.UK_AQ_PUBLIC_SCHEMA || "uk_aq_public"),
      "x-ukaq-egress-caller": "uk_aq_station_history_worker",
    },
    body: JSON.stringify({
      timeseries_id: timeseriesId,
      window_label: RPC_WINDOW_LABEL,
      since_ts: new Date(requestedSinceMs).toISOString(),
      limit_rows: RPC_ROW_LIMIT,
      include_status: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("source_http_failed");
  }
  const { payload, bytes } = await readBoundedJson(response);
  const result = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  const rpcWindowStartMs = Date.parse(String(result?.start || ""));
  if (!result || result.timeseries_id !== timeseriesId || !Array.isArray(result.data)
    || !Number.isInteger(result.count) || result.count !== result.data.length
    || !Number.isFinite(rpcWindowStartMs)) {
    throw new Error("source_coverage_unverified");
  }
  if (result.data.length > MAX_INPUT_ROWS) throw new Error("input_row_limit_exceeded");
  return {
    rows: result.data,
    bytes,
    rpcElapsedMs: Date.now() - startedMs,
    metadataAnchorMs,
    requestedSinceMs,
    rpcWindowStartMs,
  };
}

function calculate(identity, request, source) {
  const byTimestamp = new Map();
  const parsedRows = [];
  let futureRows = 0;
  for (const raw of source.rows) {
    const timestamp = Date.parse(String(raw?.observed_at ?? ""));
    if (!Number.isFinite(timestamp)) {
      throw new Error("source_timestamp_invalid");
    }
    if (timestamp <= source.requestedSinceMs || timestamp < source.rpcWindowStartMs) {
      throw new Error("source_query_bounds_unverified");
    }
    if (timestamp > request.latestCompletedHourMs) { futureRows += 1; continue; }
    if (timestamp % HOUR_MS !== 0) throw new Error("source_timestamp_convention_unverified");
    const value = raw?.value === null || raw?.value === "" ? NaN : Number(raw?.value);
    const group = byTimestamp.get(timestamp) || { sum: 0, validCount: 0, invalidCount: 0 };
    if (!Number.isFinite(value) || value < 0) {
      group.invalidCount += 1;
    } else {
      group.sum += value;
      group.validCount += 1;
    }
    byTimestamp.set(timestamp, group);
    parsedRows.push(timestamp);
  }

  let endpointMs = null;
  let latestSourceObservationMs = null;
  for (const [timestamp, group] of byTimestamp) {
    if (latestSourceObservationMs === null || timestamp > latestSourceObservationMs) latestSourceObservationMs = timestamp;
    if (group.validCount > 0 && (endpointMs === null || timestamp > endpointMs)) endpointMs = timestamp;
  }
  if (endpointMs === null) {
    if (source.metadataAnchorMs < source.rpcWindowStartMs) throw new Error("source_window_limit_exceeded");
    throw new Error("no_valid_source_observation");
  }

  const startMs = endpointMs - 24 * HOUR_MS;
  if (startMs < source.rpcWindowStartMs) throw new Error("source_window_limit_exceeded");
  if (startMs < source.requestedSinceMs) throw new Error("source_context_outside_metadata_anchor");
  const hours = new Map();
  let validRows = 0;
  let invalidRows = 0;
  for (const [timestamp, input] of byTimestamp) {
    if (timestamp <= startMs || timestamp > endpointMs) continue;
    if (input.validCount > 0) {
      hours.set(timestamp, { sum: input.sum, count: input.validCount });
      validRows += input.validCount;
    }
    invalidRows += input.invalidCount;
  }
  const helperRows = [...hours].map(([hour, input]) => ({
    connector_id: identity.connectorId,
    station_id: identity.stationId,
    timeseries_id: identity.timeseriesId,
    pollutant_code: "pm25",
    timestamp_hour_utc: new Date(hour).toISOString(),
    pm25_hourly_mean_ugm3: input.sum / input.count,
    hourly_sample_count: input.count,
  }));
  if (!hours.has(endpointMs)) helperRows.push({
    connector_id: identity.connectorId,
    station_id: identity.stationId,
    timeseries_id: identity.timeseriesId,
    pollutant_code: "pm25",
    timestamp_hour_utc: new Date(endpointMs).toISOString(),
    pm25_hourly_mean_ugm3: null,
    hourly_sample_count: null,
  });
  computeRolling24h(helperRows);
  const target = helperRows.find((row) => row.timestamp_hour_utc === new Date(endpointMs).toISOString());
  const aqi = helperRowToNormalizedAqiV1Row(target, { computedAtUtc: null });
  // The shared helper currently labels an entirely empty PM window
  // missing_input; the active PM contract classifies all <18-hour windows
  // as insufficient_samples. Keep the shared arithmetic and breakpoints.
  if (hours.size === 0) {
    aqi.daqi_source_observation_count = 0;
    aqi.daqi_calculation_status = "insufficient_samples";
    aqi.daqi_missing_reason = "insufficient_rolling_24h_hours";
  }
  const latestSourceGroup = latestSourceObservationMs === null ? null : byTimestamp.get(latestSourceObservationMs);
  return {
    aqi,
    endpointMs,
    latestSourceObservationMs,
    latestSourceObservationHasValidValue: Boolean(latestSourceGroup?.validCount),
    selectedBeforeLatestSourceObservation: latestSourceObservationMs > endpointMs,
    validRows,
    invalidRows,
    outsideRows: parsedRows.filter((timestamp) => timestamp > endpointMs).length + futureRows,
    futureRows,
    validHours: hours.size,
  };
}

export async function handleRecentAqiPrototype(request, env) {
  if (env.UK_AQ_ENV_NAME !== "TEST" || env.UK_AQ_RECENT_AQI_PROTOTYPE_ENABLED !== "true") return fail(404, "prototype_disabled");
  const allowedId = Number(String(env.UK_AQ_RECENT_AQI_PROTOTYPE_TIMESERIES_ID || ""));
  if (!Number.isSafeInteger(allowedId) || allowedId <= 0) return fail(503, "prototype_allowlist_unavailable");
  const url = new URL(request.url);
  const requestedAtMs = Date.now();
  const parsed = parseRequest(url, requestedAtMs, allowedId);
  if (!parsed) return fail(400, "prototype_request_invalid_or_unauthorised");
  const startedMs = Date.now();
  try {
    const identity = await resolveAuthoritativeTimeseriesIdentity(parsed, env, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      maxResponseBytes: 8 * 1024,
      includeLastValueAt: true,
    });
    if (identity.connectorId !== 1 || identity.pollutant !== "pm25" || identity.timeseriesId !== allowedId) return fail(409, "prototype_identity_mismatch");
    if (Date.now() - startedMs > REQUEST_TIMEOUT_MS) return fail(504, "prototype_request_timeout");
    const source = await readRecentRows(
      env,
      allowedId,
      identity.lastValueAt,
      Math.min(UPSTREAM_TIMEOUT_MS, Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - startedMs))),
    );
    if (Date.now() - startedMs > REQUEST_TIMEOUT_MS) return fail(504, "prototype_request_timeout");
    const calculated = calculate(identity, parsed, source);
    if (Date.now() - startedMs > REQUEST_TIMEOUT_MS) return fail(504, "prototype_request_timeout");
    const aqi = calculated.aqi;
    const endpointIso = new Date(calculated.endpointMs).toISOString();
    const latestSourceObservationIso = new Date(calculated.latestSourceObservationMs).toISOString();
    return reply(200, {
      schema_version: "recent_aqi_prototype_v1",
      request: {
        timeseries_id: allowedId,
        pollutant: "pm25",
        requested_at_utc: new Date(parsed.requestedAtMs).toISOString(),
        latest_completed_clock_hour_utc: new Date(parsed.latestCompletedHourMs).toISOString(),
      },
      identity: { connector_id: identity.connectorId, station_id: identity.stationId, timeseries_id: identity.timeseriesId, pollutant: "pm25" },
      selection: {
        calculation_endpoint_utc: endpointIso,
        latest_source_observation_timestamp_utc: latestSourceObservationIso,
        latest_source_observation_has_valid_value: calculated.latestSourceObservationHasValidValue,
        selected_endpoint_precedes_latest_source_observation: calculated.selectedBeforeLatestSourceObservation,
        selected_observation_age_minutes: Number(((parsed.requestedAtMs - calculated.endpointMs) / 60_000).toFixed(2)),
        selected_observation_provides_eaqi_input: true,
        metadata_anchor_last_value_at_utc: identity.lastValueAt,
        selected_endpoint_offset_from_metadata_anchor_minutes: Number(((calculated.endpointMs - source.metadataAnchorMs) / 60_000).toFixed(2)),
      },
      source: {
        mode: "ingestdb_only_uncommitted",
        transport_ok: true,
        bounded_query_complete: true,
        canonical_history_complete: false,
        response_complete: false,
        ingestdb_response_complete: true,
        partial_reasons: ["canonical_r2_not_read"],
        source_path: "uk_aq_public.uk_aq_timeseries_rpc",
        context_start_exclusive_utc: new Date(calculated.endpointMs - 24 * HOUR_MS).toISOString(),
        context_end_inclusive_utc: endpointIso,
        raw_row_count: source.rows.length,
        valid_input_row_count: calculated.validRows,
        invalid_input_row_count: calculated.invalidRows,
        outside_endpoint_row_count: calculated.outsideRows,
        valid_hour_count: calculated.validHours,
        max_input_rows: MAX_INPUT_ROWS,
        response_bytes: source.bytes,
        rpc_elapsed_ms: source.rpcElapsedMs,
      },
      aqi: {
        enabled: true,
        response_complete: false,
        partial_reasons: ["canonical_r2_not_read"],
        has_gap: calculated.validHours < 24,
        rows: [{
          connector_id: identity.connectorId,
          station_id: identity.stationId,
          timeseries_id: identity.timeseriesId,
          pollutant_code: "pm25",
          timestamp_hour_utc: aqi.timestamp_hour_utc,
          period_start_utc: new Date(calculated.endpointMs - HOUR_MS).toISOString(),
          period_end_utc: aqi.timestamp_hour_utc,
          daqi_index_level: aqi.daqi_index_level,
          daqi_input_value_ugm3: aqi.daqi_input_value_ugm3,
          daqi_source_observation_count: aqi.daqi_source_observation_count,
          daqi_required_observation_count: aqi.daqi_required_observation_count,
          daqi_calculation_status: aqi.daqi_calculation_status,
          daqi_missing_reason: aqi.daqi_missing_reason,
          eaqi_index_level: aqi.eaqi_index_level,
          eaqi_input_value_ugm3: aqi.eaqi_input_value_ugm3,
          eaqi_source_observation_count: aqi.eaqi_source_observation_count,
          eaqi_required_observation_count: aqi.eaqi_required_observation_count,
          eaqi_calculation_status: aqi.eaqi_calculation_status,
          eaqi_missing_reason: aqi.eaqi_missing_reason,
          hourly_sample_count: aqi.hourly_sample_count,
          algorithm_version: AQI_ALGORITHM_VERSION,
          source: "live_calculated_ingestdb_only",
        }],
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "prototype_failed";
    const known = new Set([
      "response_too_large", "response_missing", "source_config_missing", "source_http_failed",
      "source_coverage_unverified", "source_query_bounds_unverified", "input_row_limit_exceeded",
      "source_timestamp_invalid", "source_timestamp_convention_unverified", "source_metadata_anchor_unavailable",
      "source_window_limit_exceeded", "source_context_outside_metadata_anchor", "no_valid_source_observation",
    ]);
    const status = code === "response_too_large" || code === "input_row_limit_exceeded" ? 413
      : code === "source_config_missing" || code === "source_metadata_anchor_unavailable" ? 503
      : code === "no_valid_source_observation" ? 404
      : code === "source_window_limit_exceeded" || code === "source_context_outside_metadata_anchor" ? 422
      : 502;
    return fail(status, known.has(code) ? code : "prototype_upstream_or_identity_failed");
  }
}
