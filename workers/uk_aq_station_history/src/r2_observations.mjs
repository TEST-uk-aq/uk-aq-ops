import { mergeObservationRowsPreferR2, normalizePollutantCode } from "../../../lib/aqi/aqi_levels.mjs";

const UPSTREAM_AUTH_HEADER = "X-UK-AQ-Upstream-Auth";

function required(value) { return String(value ?? "").trim(); }

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

export async function readR2Observations({ env, identity, startMs, endMs, limit = 5000 }) {
  const url = resolveApiUrl(env.UK_AQ_OBSERVS_HISTORY_R2_API_URL);
  const secret = required(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!url || !secret) throw new Error("station_series_r2_observations_config_missing");
  url.searchParams.set("scope", "timeseries");
  url.searchParams.set("timeseries_id", String(identity.timeseriesId));
  url.searchParams.set("connector_id", String(identity.connectorId));
  url.searchParams.set("pollutant", identity.pollutant);
  url.searchParams.set("start_utc", new Date(startMs).toISOString());
  url.searchParams.set("end_utc", new Date(endMs).toISOString());
  url.searchParams.set("format", "objects");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url.toString(), { headers: { Accept: "application/json", [UPSTREAM_AUTH_HEADER]: secret } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") throw new Error("station_series_r2_observations_failed");
  const completeness = summarizeR2ObservationCompleteness(payload);
  return {
    rows: normalizeR2ObservationRows(payload, identity, startMs, endMs),
    ...completeness,
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    fetch_count: 1,
  };
}

export { mergeObservationRowsPreferR2 };
