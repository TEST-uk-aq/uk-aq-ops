import { normalizeObservedRow } from "../timeseries_v2_stitch.mjs";
import { R2HistoryFetchError } from "./contracts.mjs";
import { parseIsoMsOrNull } from "./request_window.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const TIMESERIES_UPSTREAM_FUNCTION = "uk_aq_timeseries";

function normalizeBaseUrl(value) {
  return value.replace(/\/$/, "");
}

export function parseTimeseriesRowsFromPayload(payload, sourceLabel) {
  if (!payload || typeof payload !== "object") return [];
  const rows = [];
  const sourceRows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.rows) ? payload.rows : [];
  for (const item of sourceRows) {
    const normalized = normalizeObservedRow(item, sourceLabel);
    if (normalized) rows.push(normalized);
  }
  return rows;
}

export async function loadTimeseriesConnectorId(supabaseUrl, sbSecretKey, timeseriesId) {
  if (!supabaseUrl || !sbSecretKey) return null;
  const endpoint = new URL(`${normalizeBaseUrl(supabaseUrl)}/rest/v1/timeseries`);
  endpoint.searchParams.set("select", "connector_id"); endpoint.searchParams.set("id", `eq.${timeseriesId}`); endpoint.searchParams.set("limit", "1");
  let response;
  try { response = await fetch(endpoint.toString(), { method: "GET", headers: { Accept: "application/json", "Accept-Profile": "uk_aq_core", apikey: sbSecretKey, Authorization: `Bearer ${sbSecretKey}` } }); } catch { return null; }
  if (!response.ok) return null;
  let payload; try { payload = await response.json(); } catch { return null; }
  const connectorId = Number((Array.isArray(payload) && payload.length ? payload[0] : null)?.connector_id);
  return Number.isFinite(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null;
}

export async function loadTimeseriesBindingFromR2(r2ApiUrl, upstreamAuthSecret, timeseriesId) {
  if (!r2ApiUrl || !upstreamAuthSecret) return null;
  const endpoint = new URL(r2ApiUrl); endpoint.pathname = "/v1/timeseries-binding"; endpoint.search = ""; endpoint.searchParams.set("timeseries_id", String(timeseriesId));
  let response; try { response = await fetch(endpoint.toString(), { method: "GET", headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: upstreamAuthSecret } }); } catch { return null; }
  if (response.status === 404 || !response.ok) return null;
  let payload; try { payload = await response.json(); } catch { return null; }
  return payload && typeof payload === "object" && !Array.isArray(payload) && payload.binding && typeof payload.binding === "object" && !Array.isArray(payload.binding) ? payload.binding : null;
}

export function connectorIdFromTimeseriesBinding(binding) {
  const connectorId = Number(binding?.connector_id);
  return Number.isFinite(connectorId) && connectorId > 0 ? Math.trunc(connectorId) : null;
}

export async function fetchTimeseriesOriginPayload(supabaseUrl, supabasePublishableKey, upstreamAuthSecret, params) {
  const endpoint = new URL(`${normalizeBaseUrl(supabaseUrl)}/functions/v1/${TIMESERIES_UPSTREAM_FUNCTION}`);
  endpoint.searchParams.set("timeseries_id", String(params.timeseriesId)); endpoint.searchParams.set("start_utc", params.startUtc); endpoint.searchParams.set("end_utc", params.endUtc); endpoint.searchParams.set("format", "objects"); if (params.sinceUtc) endpoint.searchParams.set("since", params.sinceUtc);
  const response = await fetch(endpoint.toString(), { method: "GET", headers: { Accept: "application/json", apikey: supabasePublishableKey, Authorization: `Bearer ${supabasePublishableKey}`, [UPSTREAM_AUTH_HEADER]: upstreamAuthSecret } });
  const text = await response.text(); let payload = null; let parsedJson = false; try { if (text) { payload = JSON.parse(text); parsedJson = true; } } catch { payload = null; }
  if (!response.ok || !parsedJson || typeof payload !== "object") throw new R2HistoryFetchError(`timeseries_origin_failed_${response.status}`, { kind: "timeseries_origin_failed", status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type"), bodyPreview: text ? text.substring(0, 1000) : "", upstreamUrlPath: endpoint.pathname + endpoint.search, worker: "observations" });
  return payload;
}

export async function fetchR2ObservationsPayload(r2ApiUrl, upstreamAuthSecret, params) {
  const endpoint = new URL(r2ApiUrl); if (!endpoint.pathname || endpoint.pathname === "/") endpoint.pathname = "/v1/observations";
  endpoint.searchParams.set("timeseries_id", String(params.timeseriesId)); endpoint.searchParams.set("connector_id", String(params.connectorId)); if (params.pollutantKey) endpoint.searchParams.set("pollutant", params.pollutantKey); endpoint.searchParams.set("start_utc", params.startUtc); endpoint.searchParams.set("end_utc", params.endUtc); if (params.sinceUtc) endpoint.searchParams.set("since_utc", params.sinceUtc); endpoint.searchParams.set("limit", String(Math.max(1, params.limitRows)));
  const response = await fetch(endpoint.toString(), { method: "GET", headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: upstreamAuthSecret } });
  const text = await response.text(); let payload = null; let parsedJson = false; try { if (text) { payload = JSON.parse(text); parsedJson = true; } } catch { payload = null; }
  if (!response.ok || !parsedJson || typeof payload !== "object") throw new R2HistoryFetchError(`r2_history_failed_${response.status}`, { kind: "r2_history_failed", status: response.status, statusText: response.statusText, contentType: response.headers.get("content-type"), bodyPreview: text ? text.substring(0, 1000) : "", upstreamUrlPath: endpoint.pathname + endpoint.search, worker: "observations" });
  return payload;
}

function mergeCoverageDiagnostics(target, sourceCoverage) {
  for (const field of ["missing_day_manifest_keys", "missing_connector_manifest_keys", "missing_parquet_keys"]) target[field] = Array.from(new Set([...(Array.isArray(target[field]) ? target[field].map((item) => String(item ?? "").trim()).filter(Boolean) : []), ...(Array.isArray(sourceCoverage[field]) ? sourceCoverage[field].map((item) => String(item ?? "").trim()).filter(Boolean) : [])]));
}

export async function fetchR2ObservationsPaged(r2ApiUrl, upstreamAuthSecret, params) {
  const rowsByObservedAt = new Map(); const pageLimitRows = Math.max(1, params.pageLimitRows); const maxPages = Math.max(1, params.maxPages); let pageSinceUtc = params.sinceUtc; let pagesFetched = 0; let exhaustedWindow = false; let mergedCoverage = null;
  while (pagesFetched < maxPages) {
    const payload = await fetchR2ObservationsPayload(r2ApiUrl, upstreamAuthSecret, { ...params, sinceUtc: pageSinceUtc, limitRows: pageLimitRows }); pagesFetched += 1;
    const payloadCoverage = payload.coverage && typeof payload.coverage === "object" ? payload.coverage : null;
    if (!mergedCoverage && payloadCoverage) mergedCoverage = { ...payloadCoverage }; else if (mergedCoverage && payloadCoverage) mergeCoverageDiagnostics(mergedCoverage, payloadCoverage);
    const pageRows = parseTimeseriesRowsFromPayload(payload, "r2"); if (!pageRows.length) { exhaustedWindow = true; break; }
    let lastObservedAt = null; for (const row of pageRows) { const observedAt = String(row?.observed_at ?? "").trim(); if (observedAt) { rowsByObservedAt.set(observedAt, row); lastObservedAt = observedAt; } }
    const responseRowCount = Number(payload.row_count); const reachedPageLimit = Number.isFinite(responseRowCount) ? responseRowCount >= pageLimitRows : pageRows.length >= pageLimitRows;
    if (!reachedPageLimit || !lastObservedAt) { exhaustedWindow = true; break; } pageSinceUtc = lastObservedAt;
  }
  return { rows: Array.from(rowsByObservedAt.values()).sort((left, right) => (parseIsoMsOrNull(String(left?.observed_at ?? "")) ?? 0) - (parseIsoMsOrNull(String(right?.observed_at ?? "")) ?? 0)), coverage: mergedCoverage, pagesFetched, hitPageLimit: !exhaustedWindow && pagesFetched >= maxPages };
}
