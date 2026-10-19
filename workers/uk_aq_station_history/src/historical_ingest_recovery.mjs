// Bounded older-chunk recovery while Prune has not yet published to R2.
// Canonical R2 must be read first. This never certifies a missing R2 page.
import { readDirectIngestObservations } from "./ingest_observations.mjs";
import {
  STATION_HISTORY_V3_OBSERVATION_ROW_BUDGET_REASON,
  STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON,
} from "./r2_observations.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 29 * DAY_MS; // Within the ingest RPC's 30-day ceiling.
const MAX_READS = 8;
const R2_BUDGET_REASONS = new Set([
  STATION_HISTORY_V3_OBSERVATION_ROW_BUDGET_REASON,
  STATION_HISTORY_V3_PHYSICAL_PAGE_BUDGET_REASON,
]);
// Absence of a daily publication scope is distinct from an unread or broken
// published R2 leaf. Never let provisional ingestion mask the latter.
const UNPUBLISHED_SCOPE_REASONS = new Set([
  "missing_day_manifest",
  "required_physical_leaf_scope_missing",
]);
const empty = () => ({ rows: [], response_complete: true, fetch_count: 0 });

function unpublishedScopeOnly(read) {
  const result = read?.result;
  const reasons = result?.partial_reasons;
  return result?.response_complete === false && result?.has_gap === true
    && Array.isArray(reasons) && reasons.length > 0
    && reasons.every((reason) => UNPUBLISHED_SCOPE_REASONS.has(reason));
}

export async function readHistoricalIngestRecovery({ reads, env, nowMs = Date.now(), timeoutMs }) {
  if (!Array.isArray(reads) || !Number.isFinite(nowMs)) {
    throw new Error("station_history_historical_ingest_recovery_invalid");
  }
  // Never mask budget-exhausted or unverified canonical history with ingest.
  if (reads.some(({ result }) => (result?.partial_reasons || []).some((reason) => R2_BUDGET_REASONS.has(reason)))) {
    return empty();
  }
  const earliestMs = nowMs - LOOKBACK_MS;
  const pending = reads.filter(unpublishedScopeOnly).map(({ segment }) => ({
    segment,
    startMs: Math.max(segment.startMs, earliestMs),
    endMs: Math.min(segment.endMs, nowMs),
  })).filter(({ startMs, endMs }) => startMs < endMs);
  if (!pending.length) return empty();
  if (pending.length > MAX_READS) {
    console.warn(JSON.stringify({ event: "station_history_historical_ingest_recovery_budget_exceeded", count: pending.length }));
    return { rows: [], response_complete: false, fetch_count: 0 };
  }
  const outcomes = await Promise.all(pending.map(async ({ segment, startMs, endMs }) => {
    try {
      return await readDirectIngestObservations({
        env,
        identity: {
          timeseriesId: segment.timeseriesId,
          connectorId: segment.connectorId,
          stationId: segment.stationId,
          pollutant: segment.pollutant,
        },
        startMs, endMs, rpcWindowStartMs: startMs, timeoutMs, nowMs,
        route: "/v1/observations-history",
      });
    } catch (error) {
      // Preserve already-read R2 history when the supplementary source fails.
      // Existing incomplete/no-store semantics permit another attempt.
      console.warn(JSON.stringify({
        event: "station_history_historical_ingest_recovery_unavailable",
        code: typeof error?.code === "string" ? error.code : "ingest_recovery_failed",
      }));
      return { rows: [], response_complete: false, fetch_count: 1 };
    }
  }));
  return {
    rows: outcomes.flatMap((outcome) => outcome.rows),
    response_complete: outcomes.every((outcome) => outcome.response_complete === true),
    fetch_count: outcomes.reduce((total, outcome) => total + outcome.fetch_count, 0),
  };
}
