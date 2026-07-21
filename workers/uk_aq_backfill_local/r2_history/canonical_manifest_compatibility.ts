export interface CanonicalManifestCompatibilityPreparation {
  prepared: Array<{
    day_utc: string;
    connector_id: number;
    connector_key: string;
    connector_overlay_path: string;
    pollutant_proposals: Array<Record<string, unknown>>;
  }>;
  run_state_path: string | null;
}

export interface CanonicalManifestCompatibilityOptions {
  env?: Record<string, string | undefined>;
  repairPlan?: unknown;
}

export async function prepareCanonicalObservationManifestCompatibility(
  options: CanonicalManifestCompatibilityOptions = {},
): Promise<CanonicalManifestCompatibilityPreparation> {
  const implementation = await import("./canonical_manifest_compatibility.mjs");
  return implementation.prepareCanonicalObservationManifestCompatibility(options);
}
