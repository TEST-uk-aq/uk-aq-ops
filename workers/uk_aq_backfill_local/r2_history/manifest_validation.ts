import * as runtime from "./manifest_validation.mjs";

export type ManifestKind = "connector" | "pollutant";
export type ManifestValidationOptions = {
  key: string;
  kind: ManifestKind;
  dayUtc: string;
  connectorId?: number | null;
};
export type ManifestValidationResult = {
  ok: boolean;
  key: string;
  kind: ManifestKind;
  failures: string[];
  expected_manifest_hash: string | null;
  stored_manifest_hash: string | null;
};

export const V2ObservationsManifestValidationError =
  runtime.V2ObservationsManifestValidationError;
export const validateV2ObservationsChildManifest =
  runtime.validateV2ObservationsChildManifest as (
    payload: unknown,
    options: ManifestValidationOptions,
  ) => ManifestValidationResult;
export const classifyRepairableV2ObservationsConnectorManifest =
  runtime.classifyRepairableV2ObservationsConnectorManifest as (
    payload: unknown,
    options: Omit<ManifestValidationOptions, "kind">,
  ) => ManifestValidationResult & {
    repairable: boolean;
    identity_failures: string[];
  };
export const assertV2ObservationsChildManifest =
  runtime.assertV2ObservationsChildManifest as (
    payload: unknown,
    options: ManifestValidationOptions,
  ) => ManifestValidationResult;
