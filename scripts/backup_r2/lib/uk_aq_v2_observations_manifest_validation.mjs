import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

function withoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...rest } = payload;
  return rest;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalidManifest(kind, key) {
  throw new Error(`Blocked dependency: invalid ${kind} manifest ${key}`);
}

// This intentionally validates the stable v2 observations child contract rather
// than merely checking that the JSON can be parsed. Both metadata-only repair
// paths must reject a structurally incomplete or mismatched child before using it
// to construct a parent manifest.
export function assertV2ObservationsChildManifest(payload, {
  key,
  kind,
  dayUtc,
  connectorId = null,
} = {}) {
  const hasRequiredAggregates = [
    "source_row_count",
    "row_count",
    "file_count",
    "total_bytes",
  ].every((field) => isNonNegativeInteger(payload?.[field]));
  const hasRequiredArrays = [
    "pollutant_codes",
    "parquet_object_keys",
    "files",
    "child_manifests",
  ].every((field) => Array.isArray(payload?.[field]));
  const hasKindArrays = kind === "connector"
    ? Array.isArray(payload?.pollutant_manifests)
    : true;
  const hasKindFields = kind === "pollutant"
    ? typeof payload?.pollutant_code === "string" && payload.pollutant_code.trim() !== ""
    : true;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.history_version !== "v2"
    || payload.domain !== "observations"
    || payload.manifest_kind !== kind
    || payload.manifest_key !== key
    || payload.day_utc !== dayUtc
    || (connectorId !== null && Number(payload.connector_id) !== connectorId)
    || typeof payload.manifest_hash !== "string"
    || payload.manifest_hash !== sha256Hex(JSON.stringify(withoutManifestHash(payload)))
    || !hasRequiredAggregates
    || !hasRequiredArrays
    || !hasKindArrays
    || !hasKindFields) {
    invalidManifest(kind, key);
  }
}
