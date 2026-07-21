// Backfill-facing import path for the authoritative v2 observations manifest
// validation contract used by metadata-only repair tooling.
export {
  V2ObservationsManifestValidationError,
  assertV2ObservationsChildManifest,
  classifyRepairableV2ObservationsConnectorManifest,
  validateV2ObservationsChildManifest,
} from "../../../scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs";
