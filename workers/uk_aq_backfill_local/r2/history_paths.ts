/** Canonical history/v2 object-key ownership for the local backfill. */

import {
  buildHistoryV2ConnectorManifestKey as canonicalConnectorManifestKey,
  buildHistoryV2DayManifestKey as canonicalDayManifestKey,
  buildHistoryV2PartKey as canonicalPartKey,
  buildHistoryV2PollutantManifestKey as canonicalPollutantManifestKey,
} from "../../shared/uk_aq_r2_history_canonical.mjs";

export function normalizePollutantCodeForR2Path(code: string): string {
  const value = String(code || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`Invalid pollutant_code for R2 path: ${code}`);
  }
  return value;
}

export function buildHistoryV2ConnectorPrefix(
  basePrefix: string, dayUtc: string, connectorId: number,
): string {
  return `${basePrefix}/day_utc=${dayUtc}/connector_id=${connectorId}`;
}

export function buildHistoryV2PollutantPrefix(
  basePrefix: string, dayUtc: string, connectorId: number, pollutantCode: string,
): string {
  return `${buildHistoryV2ConnectorPrefix(basePrefix, dayUtc, connectorId)}/pollutant_code=${
    normalizePollutantCodeForR2Path(pollutantCode)
  }`;
}

export const buildHistoryV2DayManifestKey = canonicalDayManifestKey;
export const buildHistoryV2ConnectorManifestKey = canonicalConnectorManifestKey;
export const buildHistoryV2PollutantManifestKey = canonicalPollutantManifestKey;
export const buildHistoryV2PartKey = canonicalPartKey;
