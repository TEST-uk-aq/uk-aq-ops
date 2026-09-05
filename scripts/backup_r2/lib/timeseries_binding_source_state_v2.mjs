import { normalizePrefix } from "../../../workers/shared/r2_sigv4.mjs";

export const TIMESERIES_BINDING_SOURCE_FINGERPRINT_VERSION = 2;
const TIMESERIES_BINDING_SOURCE_STATE_SCHEMA_VERSION = 1;

export function buildTimeseriesBindingSourceState({ bindingPrefix, sourceSchema, sourceFingerprint, sourceTables, authoritativeTimeseriesCount }) {
  return {
    schema_version: TIMESERIES_BINDING_SOURCE_STATE_SCHEMA_VERSION,
    history_version: "v2",
    state_kind: "timeseries_binding_source_state",
    timeseries_binding_index_prefix: normalizePrefix(bindingPrefix),
    fingerprint_algorithm: "sha256",
    fingerprint_version: TIMESERIES_BINDING_SOURCE_FINGERPRINT_VERSION,
    source_schema: String(sourceSchema || "").trim(),
    source_fingerprint: sourceFingerprint,
    source_tables: sourceTables,
    authoritative_timeseries_count: authoritativeTimeseriesCount,
  };
}

export function validTimeseriesBindingSourceState(state, { bindingPrefix, sourceSchema }) {
  return Boolean(state && typeof state === "object" && !Array.isArray(state)
    && state.schema_version === TIMESERIES_BINDING_SOURCE_STATE_SCHEMA_VERSION
    && state.history_version === "v2"
    && state.state_kind === "timeseries_binding_source_state"
    && state.fingerprint_algorithm === "sha256"
    && state.fingerprint_version === TIMESERIES_BINDING_SOURCE_FINGERPRINT_VERSION
    && state.timeseries_binding_index_prefix === normalizePrefix(bindingPrefix)
    && state.source_schema === String(sourceSchema || "").trim()
    && /^[a-f0-9]{64}$/.test(String(state.source_fingerprint || ""))
    && Array.isArray(state.source_tables));
}

