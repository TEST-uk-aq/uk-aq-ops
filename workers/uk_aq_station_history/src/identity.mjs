import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const IDENTITY_SOURCE = "authoritative_timeseries_lookup";

function required(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value) {
  const numeric = Number(String(value ?? "").trim());
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export class StationHistoryIdentityError extends Error {
  constructor(status, code, detail = undefined) {
    super(code);
    this.name = "StationHistoryIdentityError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function fail(status, code, detail = undefined) {
  throw new StationHistoryIdentityError(status, code, detail);
}

function normalizeBaseUrl(value) {
  return value.replace(/\/$/, "");
}

function embeddedObservedProperty(row) {
  const phenomenon = Array.isArray(row?.phenomena) ? row.phenomena[0] : row?.phenomena;
  const observedProperty = Array.isArray(phenomenon?.observed_properties)
    ? phenomenon.observed_properties[0]
    : phenomenon?.observed_properties;
  return { phenomenon, observedProperty };
}

export async function resolveAuthoritativeTimeseriesIdentity(request, env, {
  timeoutMs = null,
  maxResponseBytes = null,
  includeLastValueAt = false,
} = {}) {
  const timeseriesId = positiveInteger(request?.timeseriesId);
  const suppliedConnectorId = request?.connectorId == null ? null : positiveInteger(request.connectorId);
  const requestedPollutant = normalizePollutantCode(request?.pollutant);
  if (!timeseriesId) fail(400, "station_history_timeseries_id_invalid");
  if (request?.connectorId != null && !suppliedConnectorId) fail(400, "station_history_connector_id_invalid");
  if (!requestedPollutant) fail(400, "station_history_pollutant_invalid");

  const supabaseUrl = required(env?.SUPABASE_URL);
  const serviceKey = required(env?.SB_SECRET_KEY);
  if (!supabaseUrl || !serviceKey) fail(500, "station_history_identity_config_missing");

  const endpoint = new URL(`${normalizeBaseUrl(supabaseUrl)}/rest/v1/timeseries`);
  endpoint.searchParams.set(
    "select",
    `id,station_id,connector_id,phenomenon_id,ended_at${includeLastValueAt ? ",last_value_at" : ""},phenomena(connector_id,observed_property_id,observed_properties(code))`,
  );
  endpoint.searchParams.set("id", `eq.${timeseriesId}`);
  endpoint.searchParams.set("limit", "1");

  let response;
  const controller = timeoutMs === null ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        Accept: "application/json",
        "Accept-Profile": "uk_aq_core",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
  } catch {
    if (timer) clearTimeout(timer);
    fail(502, "station_history_identity_lookup_failed");
  }
  if (!response.ok) {
    if (timer) clearTimeout(timer);
    fail(502, "station_history_identity_lookup_failed", `upstream_status_${response.status}`);
  }

  let payload;
  try {
    if (maxResponseBytes === null) {
      payload = await response.json();
    } else {
      const declaredLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) fail(502, "station_history_identity_lookup_oversize");
      if (!response.body) fail(502, "station_history_identity_lookup_invalid_response");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          fail(502, "station_history_identity_lookup_oversize");
        }
        body += decoder.decode(value, { stream: true });
      }
      payload = JSON.parse(body + decoder.decode());
    }
  } catch {
    fail(502, "station_history_identity_lookup_invalid_response");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
  if (!row) fail(404, "station_history_timeseries_not_found");
  if (required(row.ended_at)) fail(409, "station_history_timeseries_inactive");

  const stationId = positiveInteger(row.station_id);
  const connectorId = positiveInteger(row.connector_id);
  const phenomenonId = positiveInteger(row.phenomenon_id);
  const { phenomenon, observedProperty } = embeddedObservedProperty(row);
  const phenomenonConnectorId = positiveInteger(phenomenon?.connector_id);
  const observedPropertyId = positiveInteger(phenomenon?.observed_property_id);
  const pollutant = normalizePollutantCode(observedProperty?.code);
  if (!stationId || !connectorId || !phenomenonId || !observedPropertyId || !pollutant) {
    fail(422, "station_history_timeseries_identity_unusable");
  }
  if (phenomenonConnectorId && phenomenonConnectorId !== connectorId) {
    fail(409, "station_history_authoritative_identity_conflict");
  }
  if (pollutant !== requestedPollutant) {
    fail(409, "station_history_pollutant_mismatch", `requested_${requestedPollutant}_authoritative_${pollutant}`);
  }
  if (suppliedConnectorId && suppliedConnectorId !== connectorId) {
    fail(409, "station_history_connector_mismatch", `supplied_${suppliedConnectorId}_authoritative_${connectorId}`);
  }

  const identity = {
    source: IDENTITY_SOURCE,
    timeseriesId,
    stationId,
    connectorId,
    phenomenonId,
    observedPropertyId,
    pollutant,
  };
  if (includeLastValueAt) {
    const lastValueAtMs = Date.parse(required(row.last_value_at));
    identity.lastValueAt = Number.isFinite(lastValueAtMs) ? new Date(lastValueAtMs).toISOString() : null;
  }
  return identity;
}

export function publicTimeseriesIdentity(identity) {
  return {
    source: IDENTITY_SOURCE,
    timeseries_id: identity.timeseriesId,
    connector_id: identity.connectorId,
    station_id: identity.stationId,
    pollutant: identity.pollutant,
  };
}

export function applyAuthoritativeTimeseriesIdentity(request, identity) {
  return {
    ...request,
    timeseriesId: identity.timeseriesId,
    connectorId: identity.connectorId,
    stationId: identity.stationId,
    pollutant: identity.pollutant,
  };
}

export { IDENTITY_SOURCE };
