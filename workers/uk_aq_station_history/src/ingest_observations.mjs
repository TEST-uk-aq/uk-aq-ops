import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const DEFAULT_SCHEMA = "uk_aq_public";
const DEFAULT_PATH = "uk_aq_observations";
const MAX_DIRECT_ROWS = 100_000;

function required(value) { return String(value ?? "").trim(); }

function normalizeBaseUrl(value) {
  return required(value).replace(/\/+$/, "");
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeTimestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeDirectIngestRows(rawRows, identity) {
  const rows = [];
  let rejected = 0;
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const rowIdentity = {
      timeseriesId: positiveInt(raw?.timeseries_id),
      connectorId: positiveInt(raw?.connector_id),
      stationId: positiveInt(raw?.station_id),
      pollutant: normalizePollutantCode(raw?.pollutant_code),
    };
    if (
      rowIdentity.timeseriesId !== identity.timeseriesId
      || rowIdentity.connectorId !== identity.connectorId
      || rowIdentity.stationId !== identity.stationId
      || rowIdentity.pollutant !== identity.pollutant
    ) {
      throw new Error("station_series_ingest_identity_mismatch");
    }
    const observedAt = normalizeTimestamp(raw?.observed_at_utc);
    const value = Number(raw?.value);
    if (!observedAt || !Number.isFinite(value) || value < 0) {
      rejected += 1;
      continue;
    }
    rows.push({
      connector_id: identity.connectorId,
      station_id: identity.stationId,
      timeseries_id: identity.timeseriesId,
      pollutant_code: identity.pollutant,
      observed_at: observedAt,
      value,
      source: "ingest",
    });
  }
  const byTimestamp = new Map();
  for (const row of rows) byTimestamp.set(row.observed_at, row);
  return {
    rows: Array.from(byTimestamp.values()).sort((left, right) => left.observed_at.localeCompare(right.observed_at)),
    rejected_row_count: rejected,
  };
}

function responseWasTruncated(response, returnedCount) {
  const contentRange = response.headers.get("Content-Range");
  const match = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(String(contentRange || "").trim());
  if (!match || match[3] === "*") return returnedCount >= MAX_DIRECT_ROWS;
  return Number(match[3]) > returnedCount;
}

export async function readDirectIngestObservations({ env, identity, startMs, endMs, timeoutMs }) {
  const baseUrl = normalizeBaseUrl(env.OBS_AQIDB_SUPABASE_URL);
  const apiKey = required(env.OBS_AQIDB_SECRET_KEY);
  const schema = required(env.UK_AQ_PUBLIC_SCHEMA) || DEFAULT_SCHEMA;
  const path = required(env.UK_AQ_OBSAQIDB_OBSERVATIONS_PATH) || DEFAULT_PATH;
  if (!baseUrl || !apiKey) throw new Error("station_series_ingest_config_missing");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("station_series_ingest_bounds_invalid");

  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(endMs).toISOString();
  const endpoint = new URL(`${baseUrl}/rest/v1/${path}`);
  endpoint.searchParams.set("select", "connector_id,station_id,timeseries_id,pollutant_code,observed_at_utc,value");
  endpoint.searchParams.set("timeseries_id", `eq.${identity.timeseriesId}`);
  endpoint.searchParams.set("observed_at_utc", `gte.${startUtc}`);
  endpoint.searchParams.append("observed_at_utc", `lt.${endUtc}`);
  endpoint.searchParams.set("order", "observed_at_utc.asc");
  endpoint.searchParams.set("limit", String(MAX_DIRECT_ROWS));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Accept-Profile": schema,
        "x-ukaq-egress-caller": "uk_aq_station_history_worker",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("station_series_ingest_timeout");
    throw new Error("station_series_ingest_failed");
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
  if (!response.ok || !Array.isArray(payload)) throw new Error("station_series_ingest_failed");
  const normalized = normalizeDirectIngestRows(payload, identity);
  const boundedRows = normalized.rows.filter((row) => {
    const observedAtMs = Date.parse(row.observed_at);
    return observedAtMs >= startMs && observedAtMs < endMs;
  });
  const rejectedRowCount = normalized.rejected_row_count + (normalized.rows.length - boundedRows.length);
  const responseComplete = !responseWasTruncated(response, payload.length);
  return {
    rows: boundedRows,
    response_complete: responseComplete,
    source_path: `${schema}.${path}`,
    start_utc: startUtc,
    end_utc: endUtc,
    fetch_count: 1,
    raw_row_count: payload.length,
    normalized_row_count: boundedRows.length,
    rejected_row_count: rejectedRowCount,
  };
}

export { DEFAULT_PATH as DEFAULT_INGEST_OBSERVATIONS_PATH, DEFAULT_SCHEMA as DEFAULT_INGEST_SCHEMA };
