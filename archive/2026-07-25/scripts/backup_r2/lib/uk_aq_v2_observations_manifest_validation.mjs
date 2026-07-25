import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";

function withoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...rest } = payload;
  return rest;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isValidIsoTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function pushFailure(failures, condition, code) {
  if (!condition) failures.push(code);
}

export class V2ObservationsManifestValidationError extends Error {
  constructor({ key, kind, failures, expectedManifestHash = null, storedManifestHash = null }) {
    super(`Blocked dependency: invalid ${kind} manifest ${key}; failures=${failures.join(",")}`);
    this.name = "V2ObservationsManifestValidationError";
    this.code = "V2_OBSERVATIONS_MANIFEST_INVALID";
    this.manifest_key = key;
    this.manifest_kind = kind;
    this.failures = [...failures];
    this.expected_manifest_hash = expectedManifestHash;
    this.stored_manifest_hash = storedManifestHash;
  }
}

// Return exact failed rules so repair diagnostics identify the incompatible
// field instead of reducing every failure to "invalid manifest".
export function validateV2ObservationsChildManifest(payload, {
  key,
  kind,
  dayUtc,
  connectorId = null,
} = {}) {
  const failures = [];
  const plainObject = isPlainObject(payload);
  pushFailure(failures, plainObject, "payload_not_object");

  if (plainObject) {
    pushFailure(failures, payload.manifest_schema_version === 2, "manifest_schema_version_not_2");
    pushFailure(failures, payload.history_schema_version === 2, "history_schema_version_not_2");
    pushFailure(failures, payload.history_version === "v2", "history_version_not_v2");
    pushFailure(failures, payload.domain === "observations", "domain_not_observations");
    pushFailure(failures, payload.manifest_kind === kind, "manifest_kind_mismatch");
    pushFailure(failures, payload.manifest_key === key, "manifest_key_mismatch");
    pushFailure(failures, payload.day_utc === dayUtc, "day_utc_mismatch");
    pushFailure(failures, Object.hasOwn(payload, "grain") && payload.grain === null, "grain_not_explicit_null");
    pushFailure(failures, Object.hasOwn(payload, "profile") && payload.profile === null, "profile_not_explicit_null");
    pushFailure(
      failures,
      connectorId === null || (Number.isInteger(payload.connector_id) && payload.connector_id === connectorId),
      "connector_id_mismatch",
    );

    for (const field of ["source_row_count", "row_count", "file_count", "total_bytes"]) {
      pushFailure(failures, isNonNegativeInteger(payload[field]), `${field}_not_non_negative_integer`);
    }
    for (const field of ["pollutant_codes", "parquet_object_keys", "files", "child_manifests", "columns"]) {
      pushFailure(failures, Array.isArray(payload[field]), `${field}_not_array`);
    }
    pushFailure(
      failures,
      payload.timeseries_row_counts === null || isPlainObject(payload.timeseries_row_counts),
      "timeseries_row_counts_not_object_or_null",
    );
    pushFailure(failures, isValidIsoTimestamp(payload.backed_up_at_utc), "backed_up_at_utc_invalid");

    if (kind === "connector") {
      pushFailure(failures, payload.pollutant_code === null, "connector_pollutant_code_not_null");
      pushFailure(failures, Array.isArray(payload.pollutant_manifests), "pollutant_manifests_not_array");
    } else if (kind === "pollutant") {
      pushFailure(
        failures,
        typeof payload.pollutant_code === "string" && payload.pollutant_code.trim() !== "",
        "pollutant_code_missing",
      );
    }
  }

  let expectedManifestHash = null;
  const storedManifestHash = plainObject && typeof payload.manifest_hash === "string"
    ? payload.manifest_hash
    : null;
  if (plainObject) {
    expectedManifestHash = sha256Hex(JSON.stringify(withoutManifestHash(payload)));
  }
  pushFailure(failures, storedManifestHash !== null, "manifest_hash_missing");
  if (storedManifestHash !== null && expectedManifestHash !== null) {
    pushFailure(failures, storedManifestHash === expectedManifestHash, "manifest_hash_mismatch");
  }

  return {
    ok: failures.length === 0,
    key,
    kind,
    failures,
    expected_manifest_hash: expectedManifestHash,
    stored_manifest_hash: storedManifestHash,
  };
}

// A connector parent can be rebuilt safely from independently validated
// pollutant children only when its immutable scope identity is exact. Its own
// aggregates, child summaries and stored hash are not trusted for rebuilding.
export function classifyRepairableV2ObservationsConnectorManifest(payload, {
  key,
  dayUtc,
  connectorId,
} = {}) {
  const validation = validateV2ObservationsChildManifest(payload, {
    key,
    kind: "connector",
    dayUtc,
    connectorId,
  });
  const identityFailures = [];
  const plainObject = isPlainObject(payload);
  pushFailure(identityFailures, plainObject, "payload_not_object");
  if (plainObject) {
    pushFailure(identityFailures, payload.history_version === "v2", "history_version_not_v2");
    pushFailure(identityFailures, payload.domain === "observations", "domain_not_observations");
    pushFailure(identityFailures, payload.manifest_kind === "connector", "manifest_kind_mismatch");
    pushFailure(identityFailures, payload.manifest_key === key, "manifest_key_mismatch");
    pushFailure(identityFailures, payload.day_utc === dayUtc, "day_utc_mismatch");
    pushFailure(
      identityFailures,
      Number.isInteger(payload.connector_id) && payload.connector_id === connectorId,
      "connector_id_mismatch",
    );
  }
  return {
    ...validation,
    repairable: !validation.ok && identityFailures.length === 0,
    identity_failures: identityFailures,
  };
}

// Both metadata-only repair paths use this strict canonical assertion before a
// child is accepted unchanged into a newly built parent.
export function assertV2ObservationsChildManifest(payload, options = {}) {
  const result = validateV2ObservationsChildManifest(payload, options);
  if (!result.ok) {
    throw new V2ObservationsManifestValidationError({
      key: result.key,
      kind: result.kind,
      failures: result.failures,
      expectedManifestHash: result.expected_manifest_hash,
      storedManifestHash: result.stored_manifest_hash,
    });
  }
  return result;
}
