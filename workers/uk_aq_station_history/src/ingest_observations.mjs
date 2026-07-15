import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const DEFAULT_SCHEMA = "uk_aq_public";
const DEFAULT_PATH = "uk_aq_observations";
const MAX_DIRECT_ROWS = 100_000;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 512;
const SERVICE = "obsaqidb_postgrest";

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

function safeIdentifier(value, fallback) {
  const text = required(value);
  return /^[A-Za-z0-9_.-]{1,160}$/.test(text) ? text : fallback;
}

export function sanitizeIngestDiagnosticText(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  let text = String(value).replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  if (!text) return fallback;
  if (/<\s*(?:!doctype|html|head|body|script|iframe)\b/i.test(text)) return "upstream returned an HTML error page";
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/\b((?:postgres(?:ql)?|mysql|redis)(?:\+[^:]+)?:\/\/)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(authorization|apikey|api[ _-]?key|token|secret|password)\s*[:=]\s*[^\s,;"']+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_DIAGNOSTIC_TEXT_LENGTH
    ? `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 15)}… [truncated]`
    : text;
}

function safePostgrestCode(value) {
  const text = required(value);
  return /^[A-Za-z0-9_-]{1,32}$/.test(text) ? text : null;
}

function safePostgrestFields(payload, fallbackMessage) {
  const object = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  return {
    postgrestCode: safePostgrestCode(object?.code),
    safeMessage: sanitizeIngestDiagnosticText(object?.message ?? object?.error, fallbackMessage),
    safeHint: sanitizeIngestDiagnosticText(object?.hint),
    safeDetails: sanitizeIngestDiagnosticText(object?.details),
  };
}

export class StationHistoryIngestError extends Error {
  constructor({
    code,
    status = 502,
    failureClass,
    schema,
    path,
    upstreamStatus = null,
    postgrestCode = null,
    safeMessage = null,
    safeHint = null,
    safeDetails = null,
  }) {
    super(code);
    this.name = "StationHistoryIngestError";
    this.code = code;
    this.status = status;
    this.failureClass = failureClass;
    this.service = SERVICE;
    this.schema = safeIdentifier(schema, DEFAULT_SCHEMA);
    this.path = safeIdentifier(path, DEFAULT_PATH);
    this.upstreamStatus = Number.isInteger(upstreamStatus) ? upstreamStatus : null;
    this.postgrestCode = safePostgrestCode(postgrestCode);
    this.safeMessage = sanitizeIngestDiagnosticText(safeMessage);
    this.safeHint = sanitizeIngestDiagnosticText(safeHint);
    this.safeDetails = sanitizeIngestDiagnosticText(safeDetails);
  }

  toSafeDetail() {
    return {
      service: this.service,
      schema: this.schema,
      path: this.path,
      ...(this.upstreamStatus === null ? {} : { upstream_status: this.upstreamStatus }),
      ...(this.postgrestCode === null ? {} : { postgrest_code: this.postgrestCode }),
      ...(this.safeMessage === null ? {} : { message: this.safeMessage }),
      ...(this.safeHint === null ? {} : { hint: this.safeHint }),
      ...(this.safeDetails === null ? {} : { details: this.safeDetails }),
    };
  }
}

function sourceContext(env) {
  return {
    schema: safeIdentifier(env.UK_AQ_PUBLIC_SCHEMA, DEFAULT_SCHEMA),
    path: safeIdentifier(env.UK_AQ_OBSAQIDB_OBSERVATIONS_PATH, DEFAULT_PATH),
  };
}

function ingestError(input) {
  return new StationHistoryIngestError(input);
}

function logIngestFailure(error, { route, identity, timeoutMs }) {
  console.error(JSON.stringify({
    event: "station_series_ingest_upstream_failed",
    route,
    timeseries_id: identity?.timeseriesId ?? null,
    connector_id: identity?.connectorId ?? null,
    station_id: identity?.stationId ?? null,
    pollutant: identity?.pollutant ?? null,
    schema: error.schema,
    path: error.path,
    upstream_status: error.upstreamStatus,
    postgrest_code: error.postgrestCode,
    safe_message: error.safeMessage,
    safe_hint: error.safeHint,
    failure_class: error.failureClass,
    timeout_ms: timeoutMs,
  }));
}

function throwLogged(error, context) {
  logIngestFailure(error, context);
  throw error;
}

export function normalizeDirectIngestRows(rawRows, identity, source = {}) {
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
      throw ingestError({
        code: "station_series_ingest_identity_mismatch",
        failureClass: "identity_mismatch",
        schema: source.schema,
        path: source.path,
        safeMessage: "direct observation row identity does not match the authoritative timeseries identity",
      });
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

export async function readDirectIngestObservations({ env, identity, startMs, endMs, timeoutMs, route = "/v1/station-series" }) {
  const baseUrl = normalizeBaseUrl(env.OBS_AQIDB_SUPABASE_URL);
  const apiKey = required(env.OBS_AQIDB_SECRET_KEY);
  const source = sourceContext(env);
  const loggingContext = { route, identity, timeoutMs };
  if (!baseUrl || !apiKey) {
    throwLogged(ingestError({
      code: "station_series_ingest_config_missing",
      status: 500,
      failureClass: "config",
      ...source,
      safeMessage: "direct observation source configuration is incomplete",
    }), loggingContext);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throwLogged(ingestError({
      code: "station_series_ingest_bounds_invalid",
      status: 500,
      failureClass: "request_bounds",
      ...source,
      safeMessage: "direct observation request bounds are invalid",
    }), loggingContext);
  }

  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(endMs).toISOString();
  const endpoint = new URL(`${baseUrl}/rest/v1/${source.path}`);
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
        "Accept-Profile": source.schema,
        "x-ukaq-egress-caller": "uk_aq_station_history_worker",
      },
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    throwLogged(ingestError({
      code: timedOut ? "station_series_ingest_timeout" : "station_series_ingest_network_failed",
      failureClass: timedOut ? "timeout" : "network",
      ...source,
      safeMessage: timedOut
        ? "direct observation request timed out"
        : sanitizeIngestDiagnosticText(error?.message, "direct observation network request failed"),
    }), loggingContext);
  } finally {
    clearTimeout(timeout);
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throwLogged(ingestError({
      code: "station_series_ingest_network_failed",
      failureClass: "network",
      ...source,
      upstreamStatus: response.status,
      safeMessage: sanitizeIngestDiagnosticText(error?.message, "direct observation response body could not be read"),
    }), loggingContext);
  }
  let payload = null;
  let jsonValid = true;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) { jsonValid = false; }
  if (!response.ok) {
    const fields = safePostgrestFields(payload, `upstream HTTP ${response.status}`);
    throwLogged(ingestError({
      code: "station_series_ingest_http_failed",
      failureClass: "http",
      ...source,
      upstreamStatus: response.status,
      ...fields,
      safeMessage: fields.safeMessage ?? (jsonValid ? `upstream HTTP ${response.status}` : `upstream HTTP ${response.status}; response was not valid JSON`),
    }), loggingContext);
  }
  if (!jsonValid) {
    throwLogged(ingestError({
      code: "station_series_ingest_invalid_json",
      failureClass: "invalid_json",
      ...source,
      upstreamStatus: response.status,
      safeMessage: "direct observation response was not valid JSON",
    }), loggingContext);
  }
  if (!Array.isArray(payload)) {
    throwLogged(ingestError({
      code: "station_series_ingest_invalid_shape",
      failureClass: "invalid_shape",
      ...source,
      upstreamStatus: response.status,
      safeMessage: "direct observation response must be a JSON array",
    }), loggingContext);
  }
  let normalized;
  try {
    normalized = normalizeDirectIngestRows(payload, identity, source);
  } catch (error) {
    if (error instanceof StationHistoryIngestError) {
      error.upstreamStatus = response.status;
      throwLogged(error, loggingContext);
    }
    throw error;
  }
  const boundedRows = normalized.rows.filter((row) => {
    const observedAtMs = Date.parse(row.observed_at);
    return observedAtMs >= startMs && observedAtMs < endMs;
  });
  const rejectedRowCount = normalized.rejected_row_count + (normalized.rows.length - boundedRows.length);
  const responseComplete = !responseWasTruncated(response, payload.length);
  return {
    rows: boundedRows,
    response_complete: responseComplete,
    source_path: `${source.schema}.${source.path}`,
    start_utc: startUtc,
    end_utc: endUtc,
    fetch_count: 1,
    raw_row_count: payload.length,
    normalized_row_count: boundedRows.length,
    rejected_row_count: rejectedRowCount,
  };
}

export { DEFAULT_PATH as DEFAULT_INGEST_OBSERVATIONS_PATH, DEFAULT_SCHEMA as DEFAULT_INGEST_SCHEMA };
