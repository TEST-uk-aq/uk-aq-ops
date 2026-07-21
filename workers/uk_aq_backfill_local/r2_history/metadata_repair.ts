import * as runtime from "./metadata_repair.mjs";

export type CompatibilityPreparation = {
  prepared: Array<{
    day_utc: string;
    connector_id: number;
    connector_key: string;
    connector_overlay_path: string;
    pollutant_proposals: Array<Record<string, unknown>>;
  }>;
  run_state_path: string | null;
};

export const prepareLegacyObservationManifestCompatibility =
  runtime.prepareLegacyObservationManifestCompatibility as (
    options: { env?: Record<string, string>; repairPlan: unknown },
  ) => Promise<CompatibilityPreparation>;
export const finaliseLegacyObservationManifestCompatibility =
  runtime.finaliseLegacyObservationManifestCompatibility as (
    options: { output: unknown; preparation: CompatibilityPreparation },
  ) => unknown;
