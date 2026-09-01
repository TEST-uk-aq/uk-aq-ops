import { mergeObservationRowsPreferR2, normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";
const DAY_MS = 24 * 60 * 60 * 1000;
const V3_PHYSICAL_PAGE_SCHEMA_VERSION = 2;
const V3_MAX_PHYSICAL_ROWS_PER_PAGE = 1024;

export const STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET = 16;
export const STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON =
  "observation_history_physical_page_budget_exceeded";

function required(value) { return String(value ?? "").trim(); }
function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

function resolveApiUrl(value) {
  const text = required(value);
  if (!text) return null;
  const url = new URL(text);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") url.pathname = "/v1/observations";
  else if (!path.endsWith("/v1/observations")) url.pathname = `${path}/v1/observations`;
  url.search = "";
  return url;
}

export function usesV3PhysicalObservationPages(env = {}) {
  return required(env.UK_AQ_R2_HISTORY_INDEX_VERSION) === "v3";
}

export function createStationHistoryV3PageBudget(limit = STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("station_history_v3_page_budget_invalid");
  return { limit, used: 0 };
}

export function splitR2ObservationRangeByUtcDay(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("station_history_r2_observation_range_invalid");
  }
  const pieces = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const nextUtcMidnight = (Math.floor(cursor / DAY_MS) + 1) * DAY_MS;
    const pieceEnd = Math.min(endMs, nextUtcMidnight, cursor + DAY_MS);
    if (pieceEnd <= cursor || pieceEnd - cursor > DAY_MS) {
      throw new Error("station_history_v3_logical_piece_invalid");
    }
    pieces.push({ startMs: cursor, endMs: pieceEnd });
    cursor = pieceEnd;
  }
  return pieces;
}

export function buildR2ObservationRequestUrl({
  baseUrl,
  identity,
  startMs,
  endMs,
  limit = 5000,
  physicalCursor = null,
  physicalPaging = false,
}) {
  const url = resolveApiUrl(baseUrl);
  if (!url) return null;
  url.searchParams.set("scope", "timeseries");
  url.searchParams.set("format", "objects");
  url.searchParams.set("timeseries_id", String(identity.timeseriesId));
  url.searchParams.set("connector_id", String(identity.connectorId));
  url.searchParams.set("pollutant", identity.pollutant);
  url.searchParams.set("start_utc", new Date(startMs).toISOString());
  url.searchParams.set("end_utc", new Date(endMs).toISOString());
  if (physicalPaging) {
    if (physicalCursor) url.searchParams.set("physical_cursor", physicalCursor);
  } else {
    url.searchParams.set("limit", String(limit));
  }
  return url;
}

export function summarizeR2ObservationCompleteness(payload) {
  const coverageState = String(payload?.coverage_state || payload?.coverage?.coverage_state || "").trim().toLowerCase();
  const hasGap = payload?.has_gap === true || payload?.coverage?.has_gap === true;
  const responseComplete = payload?.response_complete !== false
    && payload?.coverage?.response_complete !== false
    && !hasGap
    && (!coverageState || coverageState === "complete");
  return {
    response_complete: responseComplete,
    has_gap: hasGap || !responseComplete,
    coverage_state: coverageState || (responseComplete ? "complete" : "partial"),
    partial_reasons: Array.isArray(payload?.partial_reasons) ? payload.partial_reasons.map(String) : [],
    coverage: payload?.coverage || null,
  };
}

export function normalizeR2ObservationRows(payload, identity, startMs, endMs) {
  for (const [actual, expected] of [
    [Number(payload?.timeseries_id), identity.timeseriesId],
    [Number(payload?.connector_id), identity.connectorId],
    [normalizePollutantCode(payload?.pollutant), identity.pollutant],
  ]) {
    if (actual && actual !== expected) throw new Error("station_series_r2_observation_identity_mismatch");
  }
  const rows = [];
  for (const raw of Array.isArray(payload?.rows) ? payload.rows : []) {
    const observedAtMs = Date.parse(String(raw?.observed_at || raw?.observed_at_utc || ""));
    const value = Number(raw?.value);
    if (!Number.isFinite(observedAtMs) || observedAtMs < startMs || observedAtMs >= endMs || !Number.isFinite(value) || value < 0) continue;
    rows.push({
      connector_id: identity.connectorId,
      station_id: identity.stationId,
      timeseries_id: identity.timeseriesId,
      pollutant_code: identity.pollutant,
      observed_at: new Date(observedAtMs).toISOString(),
      value,
      source: "r2",
    });
  }
  return rows;
}

function normalizeV3PhysicalPage(payload, identity, piece, expectedPage, suppliedCursor) {
  if (!payload || typeof payload !== "object" || payload.ok !== true) {
    throw new Error("station_history_v3_leaf_response_invalid");
  }
  const expectedStart = new Date(piece.startMs).toISOString();
  const expectedEnd = new Date(piece.endMs).toISOString();
  for (const [actual, expected] of [
    [Number(payload.timeseries_id), identity.timeseriesId],
    [Number(payload.connector_id), identity.connectorId],
    [normalizePollutantCode(payload.pollutant), identity.pollutant],
    [required(payload.start_utc), expectedStart],
    [required(payload.end_utc), expectedEnd],
  ]) {
    if (actual !== expected) throw new Error("station_history_v3_leaf_identity_contradiction");
  }
  const page = payload.physical_page;
  if (
    page?.schema_version !== V3_PHYSICAL_PAGE_SCHEMA_VERSION
    || page.page_number !== expectedPage
    || page.continuation_cursor_supplied !== Boolean(suppliedCursor)
    || !Number.isSafeInteger(page.segments_decoded)
    || page.segments_decoded < 0
    || page.segments_decoded > 1
    || !Number.isSafeInteger(page.physical_rows_decoded)
    || page.physical_rows_decoded < 0
    || page.physical_rows_decoded > V3_MAX_PHYSICAL_ROWS_PER_PAGE
  ) throw new Error("station_history_v3_leaf_page_contradiction");
  const paginationComplete = page.pagination_complete === true;
  if (paginationComplete !== (page.next_cursor === null)) {
    throw new Error("station_history_v3_leaf_page_contradiction");
  }
  if (!paginationComplete && (
    typeof page.next_cursor !== "string"
    || !page.next_cursor
    || page.next_cursor === suppliedCursor
  )) throw new Error("station_history_v3_leaf_cursor_loop");
  if (payload.response_complete === true && (!paginationComplete || payload.has_gap === true)) {
    throw new Error("station_history_v3_leaf_completeness_contradiction");
  }
  const rows = [];
  let previousMs = null;
  for (const raw of Array.isArray(payload.rows) ? payload.rows : []) {
    const observedAtMs = Date.parse(String(raw?.observed_at || raw?.observed_at_utc || ""));
    const value = Number(raw?.value);
    if (
      !Number.isFinite(observedAtMs)
      || observedAtMs < piece.startMs
      || observedAtMs >= piece.endMs
      || !Number.isFinite(value)
      || value < 0
      || (previousMs !== null && observedAtMs < previousMs)
    ) throw new Error("station_history_v3_leaf_row_invalid");
    previousMs = observedAtMs;
    rows.push({
      connector_id: identity.connectorId,
      station_id: identity.stationId,
      timeseries_id: identity.timeseriesId,
      pollutant_code: identity.pollutant,
      observed_at: new Date(observedAtMs).toISOString(),
      value,
      source: "r2",
    });
  }
  if (rows.length > page.physical_rows_decoded) {
    throw new Error("station_history_v3_leaf_page_contradiction");
  }
  return { page, paginationComplete, rows };
}

async function fetchObservationJson(target, secret, fetchApi) {
  let response;
  try {
    response = await fetchApi(target.toString(), {
      headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret },
    });
  } catch {
    throw new Error("station_series_r2_observations_failed");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error("station_series_r2_observations_failed");
  }
  return payload;
}

async function readV2R2Observations({ env, identity, startMs, endMs, limit, fetchApi }) {
  const url = buildR2ObservationRequestUrl({
    baseUrl: env.UK_AQ_OBSERVS_HISTORY_R2_API_URL,
    identity,
    startMs,
    endMs,
    limit,
  });
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!url || !secret) throw new Error("station_series_r2_observations_config_missing");
  const payload = await fetchObservationJson(url, secret, fetchApi);
  const completeness = summarizeR2ObservationCompleteness(payload);
  return {
    rows: normalizeR2ObservationRows(payload, identity, startMs, endMs),
    ...completeness,
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    fetch_count: 1,
  };
}

async function readV3R2Observations({ env, identity, startMs, endMs, pageBudget, fetchApi }) {
  const baseUrl = required(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!baseUrl || !secret) throw new Error("station_series_r2_observations_config_missing");
  const budget = pageBudget || createStationHistoryV3PageBudget();
  const fetchCountAtStart = budget.used;
  const rows = [];
  const partialReasons = [];
  let hasGap = false;
  let allPiecesComplete = true;
  let previousMs = null;
  let budgetExceeded = false;

  outer: for (const piece of splitR2ObservationRangeByUtcDay(startMs, endMs)) {
    let cursor = null;
    let expectedPage = 1;
    const seenCursors = new Set();
    while (true) {
      if (budget.used >= budget.limit) {
        budgetExceeded = true;
        allPiecesComplete = false;
        break outer;
      }
      const target = buildR2ObservationRequestUrl({
        baseUrl,
        identity,
        startMs: piece.startMs,
        endMs: piece.endMs,
        physicalCursor: cursor,
        physicalPaging: true,
      });
      budget.used += 1;
      const payload = await fetchObservationJson(target, secret, fetchApi);
      const normalized = normalizeV3PhysicalPage(payload, identity, piece, expectedPage, cursor);
      for (const row of normalized.rows) {
        const observedAtMs = Date.parse(row.observed_at);
        if (previousMs !== null && observedAtMs < previousMs) {
          throw new Error("station_history_v3_cross_page_row_order_invalid");
        }
        previousMs = observedAtMs;
        rows.push(row);
      }
      hasGap ||= payload.has_gap === true;
      partialReasons.push(...(
        Array.isArray(payload.coverage_partial_reasons)
          ? payload.coverage_partial_reasons.map(String)
          : []
      ));
      if (normalized.paginationComplete) {
        if (payload.response_complete !== true) allPiecesComplete = false;
        break;
      }
      if (seenCursors.has(normalized.page.next_cursor)) {
        throw new Error("station_history_v3_leaf_cursor_loop");
      }
      seenCursors.add(normalized.page.next_cursor);
      cursor = normalized.page.next_cursor;
      expectedPage += 1;
    }
  }

  if (budgetExceeded) partialReasons.push(STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON);
  const responseComplete = allPiecesComplete && !hasGap && !budgetExceeded;
  return {
    rows,
    response_complete: responseComplete,
    has_gap: hasGap || !responseComplete,
    coverage_state: responseComplete ? "complete" : "partial",
    partial_reasons: uniqueStrings(partialReasons),
    coverage: null,
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    fetch_count: budget.used - fetchCountAtStart,
  };
}

export async function readR2Observations({
  env,
  identity,
  startMs,
  endMs,
  limit = 5000,
  pageBudget = null,
  fetchApi = fetch,
}) {
  if (usesV3PhysicalObservationPages(env)) {
    return readV3R2Observations({ env, identity, startMs, endMs, pageBudget, fetchApi });
  }
  return readV2R2Observations({ env, identity, startMs, endMs, limit, fetchApi });
}

export { mergeObservationRowsPreferR2 };
