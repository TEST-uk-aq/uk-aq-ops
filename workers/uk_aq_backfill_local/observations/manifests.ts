/** Observation history/v2 manifest construction and validation. */

import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2PollutantManifest,
  validateCanonicalHistoryV2Manifest,
} from "../../shared/uk_aq_r2_history_canonical.mjs";

export function createObservationV2PollutantManifest(
  args: Record<string, unknown> & {
    dayUtc: string; connectorId: number; pollutantCode: string;
    observationContentHash: Record<string, unknown>;
  },
) {
  const manifest = buildHistoryV2PollutantManifest({
    domain: "observations",
    ...args,
    observationContentHash: args.observationContentHash,
  } as never);
  validateCanonicalHistoryV2Manifest(manifest, {
    domain: "observations", manifest_kind: "pollutant",
    day_utc: args.dayUtc, connector_id: args.connectorId,
    pollutant_code: args.pollutantCode,
  });
  return manifest;
}

export function createObservationV2ConnectorManifest(
  args: Record<string, unknown> & { dayUtc: string; connectorId: number },
) {
  const manifest = buildHistoryV2ConnectorManifest({
    domain: "observations", ...args,
  } as never);
  validateCanonicalHistoryV2Manifest(manifest, {
    domain: "observations", manifest_kind: "connector",
    day_utc: args.dayUtc, connector_id: args.connectorId,
  });
  return manifest;
}
