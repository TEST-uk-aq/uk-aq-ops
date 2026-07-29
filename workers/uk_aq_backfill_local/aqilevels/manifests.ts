/** AQI history/v2 manifest construction and validation. */

import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2PollutantManifest,
  validateCanonicalHistoryV2Manifest,
} from "../../shared/uk_aq_r2_history_canonical.mjs";

export function createAqiV2PollutantManifest(
  args: Record<string, unknown> & {
    profile: "data" | "debug"; dayUtc: string; connectorId: number;
  },
) {
  const manifest = buildHistoryV2PollutantManifest({
    domain: "aqilevels", grain: "hourly", ...args,
  } as never);
  validateCanonicalHistoryV2Manifest(manifest, {
    domain: "aqilevels", manifest_kind: "pollutant", profile: args.profile,
  });
  return manifest;
}

export function createAqiV2ConnectorManifest(
  args: Record<string, unknown> & {
    profile: "data" | "debug"; dayUtc: string; connectorId: number;
  },
) {
  const manifest = buildHistoryV2ConnectorManifest({
    domain: "aqilevels", grain: "hourly", ...args,
  } as never);
  validateCanonicalHistoryV2Manifest(manifest, {
    domain: "aqilevels", manifest_kind: "connector", profile: args.profile,
  });
  return manifest;
}
