/** Explicit producer projection. Persisted v8 hashes still cover their original fields verbatim. */
import { createHash } from "node:crypto";
export function canonicalOfficialRdataJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalOfficialRdataJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))).map((key) =>
    `${JSON.stringify(key)}:${canonicalOfficialRdataJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function officialRdataSha256(value) {
  return createHash("sha256").update(Buffer.from(canonicalOfficialRdataJson(value), "utf8")).digest("hex");
}
const ordered = (values) => values.sort((a, b) => Buffer.compare(
  Buffer.from(canonicalOfficialRdataJson(a), "utf8"), Buffer.from(canonicalOfficialRdataJson(b), "utf8"),
));
function select(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || fields.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Official RData semantic dependency is incomplete");
  }
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
export function officialRdataAvailabilitySemanticIdentity(scopes) {
  return ordered(scopes.map((scope) => ({
    ...select(scope, ["day_utc", "site_code", "source_year", "source_file_key",
      "pollutant_code", "station_id", "timeseries_id", "reason", "canonical_url",
      "final_url", "http_status"]),
    raw_source_windows: ordered(scope.raw_source_windows.map((window) => select(window,
      ["canonical_day_utc", "raw_start_utc", "raw_end_exclusive_utc"]))),
    canonical_unavailable_windows: ordered(scope.canonical_unavailable_windows.map((window) =>
      select(window, ["canonical_day_utc", "canonical_start_utc", "canonical_end_exclusive_utc"]))),
  })));
}
export function officialRdataPreservedBaselineSemanticIdentity(identity) {
  if (identity?.source !== "dropbox" || !Array.isArray(identity.partition_identities)) {
    throw new Error("Official RData preservation requires pinned Dropbox identity");
  }
  return {
    source: "dropbox",
    partition_identities: ordered(identity.partition_identities.map((partition) => ({
      ...select(partition, ["day_utc", "connector_id", "pollutant_code", "manifest_key",
        "baseline_state", "preserved_row_count"]),
      source_unavailable_timeseries_ids: [...partition.source_unavailable_timeseries_ids].sort((a, b) => a - b),
      source_unavailable_scopes: officialRdataAvailabilitySemanticIdentity(partition.source_unavailable_scopes),
      object_identities: ordered(partition.object_identities.map((object) =>
        select(object, ["object_key", "bytes", "sha256"]))),
    }))),
  };
}

export const OFFICIAL_RDATA_V8_SEMANTIC_EVIDENCE_FIELDS = Object.freeze([
  "schema_version",
  "semantic_evidence_contract",
  "source_adapter",
  "day_utc",
  "connector_id",
  "source_file_identities_sha256",
  "requested_pollutant_set",
  "contract",
  "evidence_contract_version",
  "history_generation",
  "source_label_registry_snapshot_content_sha256",
  "authoritative_station_timeseries_mapping_sha256",
  "sos_site_ref_bridge_mapping_identity",
  "sos_site_ref_bridge_artifact_sha256",
  "observed_property_mapping_sha256",
  "source_artifact_availability_contract_version",
  "source_artifact_availability_sha256",
  "preserved_baseline_dependency_contract_version",
  "preserved_baseline_dependency_sha256",
  "rdata_decoder_contract_version",
  "timestamp_mapping",
  "observation_content_hash_contract_version",
  "source_evidence_input_sha256",
  "enumeration_complete",
  "files_enumerated",
  "files_required",
  "files_read",
  "files_authoritatively_absent",
  "source_file_identities",
  "source_records_examined",
  "source_csv_records_scanned",
  "canonical_rows_mapped",
  "missing_binding_groups",
  "missing_binding_rows",
  "canonical_rows_file",
  "canonical_rows_sha256",
  "canonical_rows_bytes",
  "total_rows",
  "per_timeseries_counts",
  "per_pollutant_counts",
  "observation_content_hashes",
  "pollutant_set",
  "source_available_timeseries_ids",
  "source_available_pollutant_codes",
  "source_unavailable_timeseries_ids",
  "source_unavailable_scopes",
  "preserved_baseline_rows_file",
  "preserved_baseline_rows_sha256",
  "preserved_baseline_rows_bytes",
  "preserved_baseline_row_count",
  "preserved_baseline_identity",
  "final_target_row_count",
  "final_target_timeseries_row_counts",
  "final_target_pollutant_counts",
  "empty_final_target_pollutant_codes",
  "final_target_observation_content_hashes",
  "source_rows_before_canonical_dedupe",
  "duplicate_rows_removed_by_canonical_normalisation",
  "duplicate_canonical_row_count",
  "duplicate_canonical_row_identity_samples",
  "uncanonicalisable_source_row_count",
  "source_adapter_blocked_row_count",
  "source_adapter_blocked_row_samples",
  "out_of_scope_source_adapter_blocked_row_count",
  "blocked_row_count",
  "blocked_row_samples",
  "skipped_row_count",
  "inactive_identity_rows_skipped",
  "source_label_classification_counts",
  "source_label_target_day_row_counts",
  "source_label_summary",
  "source_label_classifications",
  "mapping_audit",
  "source_verification_status_counts",
]);
