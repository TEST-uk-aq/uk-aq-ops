import { normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const DEFAULT_SCHEMA = "uk_aq_public";
const RPC_PATH = "rpc/uk_aq_timeseries_rpc";
const MAX_DIAGNOSTIC_TEXT_LENGTH = 512;
const SERVICE = "ingestdb";
const MAX_RPC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

function isUnsupportedRpcSignature(fields) {
  const message = `${fields.safeMessage ?? ""} ${fields.safeDetails ?? ""}`.toLowerCase();
  return fields.postgrestCode === "PGRST202"
    || (message.includes("could not find the function") && message.includes("uk_aq_timeseries_rpc"));
}

export function selectDirectIngestWindowLabel(startMs, nowMs = Date.now()) {
  const spanHours = (nowMs - startMs) / (60 * 60 * 1000);
  if (!Number.isFinite(spanHours) || spanHours > 24 * 7) return "30d";
  if (spanHours <= 12) return "12h";
  if (spanHours <= 24) return "24h";
  return "7d";
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
    httpAttemptCount = 0,
    logicalFetchCount = 1,
  }) {
    super(code);
    this.name = "StationHistoryIngestError";
    this.code = code;
    this.status = status;
    this.failureClass = failureClass;
    this.service = SERVICE;
    this.schema = safeIdentifier(schema, DEFAULT_SCHEMA);
    this.path = RPC_PATH;
    this.upstreamStatus = Number.isInteger(upstreamStatus) ? upstreamStatus : null;
    this.postgrestCode = safePostgrestCode(postgrestCode);
    this.safeMessage = sanitizeIngestDiagnosticText(safeMessage);
    this.safeHint = sanitizeIngestDiagnosticText(safeHint);
    this.safeDetails = sanitizeIngestDiagnosticText(safeDetails);
    this.httpAttemptCount = Number.isInteger(httpAttemptCount) && httpAttemptCount >= 0 ? httpAttemptCount : 0;
    this.logicalFetchCount = Number.isInteger(logicalFetchCount) && logicalFetchCount >= 0 ? logicalFetchCount : 0;
  }

  toSafeDetail() {
    return {
      service: this.service,
      schema: this.schema,
      path: this.path,
      logical_ingest_fetch_count: this.logicalFetchCount,
      http_attempt_count: this.httpAttemptCount,
      ...(this.upstreamStatus === null ? {} : { upstream_status: this.upstreamStatus }),
      ...(this.postgrestCode === null ? {} : { postgrest_code: this.postgrestCode }),
      ...(this.safeMessage === null ? {} : { message: this.safeMessage }),
      ...(this.safeHint === null ? {} : { hint: this.safeHint }),
      ...(this.safeDetails === null ? {} : { details: this.safeDetails }),
    };
  }
}

function sourceContext(env) {
  return { schema: safeIdentifier(env.UK_AQ_PUBLIC_SCHEMA, DEFAULT_SCHEMA), path: RPC_PATH };
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
    http_attempt_count: error.httpAttemptCount,
    logical_ingest_fetch_count: error.logicalFetchCount,
  }));
}

function throwLogged(error, context) {
  logIngestFailure(error, context);
  throw error;
}

function optionalIdentityMatches(raw, identity) {
  const comparisons = [
    [raw?.timeseries_id, identity.timeseriesId, positiveInt],
    [raw?.connector_id, identity.connectorId, positiveInt],
    [raw?.station_id, identity.stationId, positiveInt],
    [raw?.pollutant_code, identity.pollutant, normalizePollutantCode],
  ];
  return comparisons.every(([value, expected, normalizer]) => value === undefined || value === null || normalizer(value) === expected);
}

export function normalizeDirectIngestRows(rawRows, identity, source = {}) {
  const rows = [];
  let rejected = 0;
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    if (!optionalIdentityMatches(raw, identity)) {
      throw ingestError({
        code: "station_series_ingest_identity_mismatch",
        failureClass: "identity_mismatch",
        schema: source.schema,
        path: source.path,
        safeMessage: "direct observation row identity does not match the authoritative timeseries identity",
      });
    }
    const observedAt = normalizeTimestamp(raw?.observed_at ?? raw?.observed_at_utc);
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
      ...(raw?.status === undefined || raw?.status === null ? {} : { status: raw.status }),
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

export async function readDirectIngestObservations({ env, identity, startMs, endMs, timeoutMs, nowMs = Date.now(), route = "/v1/station-series" }) {
  const baseUrl = normalizeBaseUrl(env.SUPABASE_URL);
  const apiKey = required(env.SB_SECRET_KEY);
  const source = sourceContext(env);
  const loggingContext = { route, identity, timeoutMs };
  if (!baseUrl || !apiKey) {
    throwLogged(ingestError({
      code: "station_series_ingest_config_missing",
      status: 500,
      failureClass: "config",
      ...source,
      safeMessage: "direct observation source configuration is incomplete",
      logicalFetchCount: 0,
    }), loggingContext);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throwLogged(ingestError({
      code: "station_series_ingest_bounds_invalid",
      status: 500,
      failureClass: "request_bounds",
      ...source,
      safeMessage: "direct observation request bounds are invalid",
      logicalFetchCount: 0,
    }), loggingContext);
  }

  const startUtc = new Date(startMs).toISOString();
  const endUtc = new Date(endMs).toISOString();
  const windowLabel = selectDirectIngestWindowLabel(startMs, nowMs);
  const rpcWindowCoversRequiredStart = nowMs - startMs <= MAX_RPC_WINDOW_MS;
  const endpoint = new URL(`${baseUrl}/rest/v1/${RPC_PATH}`);
  const requestBody = {
    timeseries_id: identity.timeseriesId,
    window_label: windowLabel,
    limit_rows: null,
    since_ts: null,
    include_status: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Accept-Profile": source.schema,
        "Content-Profile": source.schema,
        "x-ukaq-egress-caller": "uk_aq_station_history_worker",
      },
      body: JSON.stringify(requestBody),
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
      httpAttemptCount: 1,
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
      httpAttemptCount: 1,
    }), loggingContext);
  }
  let payload = null;
  let jsonValid = true;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) { jsonValid = false; }
  if (!response.ok) {
    const fields = safePostgrestFields(payload, `upstream HTTP ${response.status}`);
    throwLogged(ingestError({
      code: isUnsupportedRpcSignature(fields) ? "station_series_ingest_unsupported_rpc_signature" : "station_series_ingest_http_failed",
      failureClass: isUnsupportedRpcSignature(fields) ? "unsupported_rpc_signature" : "http",
      ...source,
      upstreamStatus: response.status,
      ...fields,
      safeMessage: fields.safeMessage ?? (jsonValid ? `upstream HTTP ${response.status}` : `upstream HTTP ${response.status}; response was not valid JSON`),
      httpAttemptCount: 1,
    }), loggingContext);
  }
  if (!jsonValid) {
    throwLogged(ingestError({
      code: "station_series_ingest_invalid_json",
      failureClass: "invalid_json",
      ...source,
      upstreamStatus: response.status,
      safeMessage: "direct observation RPC response was not valid JSON",
      httpAttemptCount: 1,
    }), loggingContext);
  }
  if (!Array.isArray(payload) || payload.length < 1 || !payload[0] || typeof payload[0] !== "object") {
    throwLogged(ingestError({
      code: "station_series_ingest_invalid_rpc_result_shape",
      failureClass: "invalid_rpc_result_shape",
      ...source,
      upstreamStatus: response.status,
      safeMessage: "direct observation RPC response must contain a result object",
      httpAttemptCount: 1,
    }), loggingContext);
  }
  const rpcResult = payload[0];
  if (!Array.isArray(rpcResult.data)) {
    throwLogged(ingestError({
      code: "station_series_ingest_invalid_data_shape",
      failureClass: "invalid_data_shape",
      ...source,
      upstreamStatus: response.status,
      safeMessage: "direct observation RPC result data must be a JSON array",
      httpAttemptCount: 1,
    }), loggingContext);
  }
  let normalized;
  try {
    normalized = normalizeDirectIngestRows(rpcResult.data, identity, source);
  } catch (error) {
    if (error instanceof StationHistoryIngestError) {
      error.upstreamStatus = response.status;
      error.httpAttemptCount = 1;
      throwLogged(error, loggingContext);
    }
    throw error;
  }
  const boundedRows = normalized.rows.filter((row) => {
    const observedAtMs = Date.parse(row.observed_at);
    return observedAtMs >= startMs && observedAtMs < endMs;
  });
  const rejectedRowCount = normalized.rejected_row_count + (normalized.rows.length - boundedRows.length);
  return {
    rows: boundedRows,
    guideline: rpcResult.guideline ?? null,
    response_complete: rpcWindowCoversRequiredStart,
    source_path: `${source.schema}.${RPC_PATH}`,
    start_utc: startUtc,
    end_utc: endUtc,
    rpc_window_label: windowLabel,
    rpc_window_covers_required_start: rpcWindowCoversRequiredStart,
    rpc_window_start_utc: normalizeTimestamp(rpcResult.start),
    rpc_window_end_utc: normalizeTimestamp(rpcResult.end),
    fetch_count: 1,
    logical_fetch_count: 1,
    http_attempt_count: 1,
    raw_row_count: rpcResult.data.length,
    normalized_row_count: boundedRows.length,
    rejected_row_count: rejectedRowCount,
  };
}

export { DEFAULT_SCHEMA as DEFAULT_INGEST_SCHEMA, RPC_PATH as DIRECT_INGEST_RPC_PATH };
