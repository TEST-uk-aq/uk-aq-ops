import assert from "node:assert/strict";
import test from "node:test";

import {
  GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
  GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  canonicalGenericV2SelectedScopeAuthority,
} from "../lib/generic_v2_official_rdata_proposal_validation.mjs";

test("generic fixed-v2 authority has independent versioned contract identities", () => {
  assert.equal(
    GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
    "uk_aq_generic_integrity_v2_selected_scope_authority_v1",
  );
  assert.equal(
    GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    "uk_aq_generic_integrity_v2_transition_state_fingerprint_v1",
  );
});

test("generic fixed-v2 authority rejects a relabelled fixed-v3 authority", () => {
  assert.throws(
    () => canonicalGenericV2SelectedScopeAuthority({
      generic_integrity_selected_scope_authority: {
        contract_version: "uk_aq_generic_integrity_v3_selected_scope_authority_v3",
        history_generation: "v3",
        selected_scopes: [],
        metadata_only_scopes: [],
        authorised_pollutant_tombstone_prefixes: [],
      },
    }),
    /Generic fixed-v2 selected-scope authority is unavailable/,
  );
});

test("generic fixed-v2 authority binds exact persisted official source evidence", () => {
  const hash = "a".repeat(64);
  const prefix = "history/v2/observations/day_utc=2026-10-01"
    + "/connector_id=9/pollutant_code=no2";
  const sourceAuthority = {
    contract_version: "uk_aq_generic_v2_official_rdata_scope_source_authority_v1",
    authority_kind: "persisted_official_rdata_v7_semantic_evidence",
    history_generation: "v2",
    day_utc: "2026-10-01",
    connector_id: 9,
    source_adapter: "waqn",
    pollutant_code: "no2",
    evidence_id: 7,
    semantic_evidence_sha256: hash,
    source_evidence_input_sha256: hash,
    acquisition_audit_id: 8,
    acquisition_audit_sha256: hash,
    source_file_identities_sha256: hash,
    source_file_identities: [],
    files_required: [],
    files_read: [],
    files_authoritatively_absent: [],
    source_available_timeseries_ids: [],
    source_unavailable_timeseries_ids: [],
    source_unavailable_scopes: [],
    source_artifact_availability_sha256: hash,
    authoritative_station_timeseries_mapping_sha256: hash,
    observed_property_mapping_sha256: hash,
    preserved_baseline_dependency_sha256: hash,
    preserved_baseline_identity: {},
    canonical_rows_sha256: hash,
    canonical_rows_bytes: 2,
    final_target_row_count: 0,
    final_target_timeseries_row_counts: {},
    final_target_pollutant_counts: { no2: 0 },
    final_target_observation_content_hashes: {},
    selected_final_target_row_count: 0,
    selected_final_target_authoritatively_empty: true,
    timestamp_mapping: "rdata_date_beginning_plus_one_hour_to_observed_at_utc",
  };
  const scope = {
    day_utc: "2026-10-01",
    connector_id: 9,
    pollutant_code: "no2",
    pollutant_prefix: prefix,
    outcome: "authoritative_no_data_replacement",
    authorised_tombstone_prefix: prefix,
    replacement_object_keys: [],
    preservation_evidence: null,
    source_evidence_authority: sourceAuthority,
  };
  const runState = {
    objects: {},
    tombstone_prefixes: [{ prefix, proposed: true }],
    explicit_official_force_partitions: [],
    explicit_official_force_replacement: false,
    generic_integrity_selected_scope_authority: {
      contract_version: GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
      history_generation: "v2",
      selected_scopes: [scope],
      metadata_only_scopes: [],
      metadata_only_derived_write_object_keys: [],
      explicit_force_targets: [],
      forced_republication_parquet_keys: [],
      authorised_pollutant_tombstone_prefixes: [prefix],
    },
  };
  assert.equal(
    canonicalGenericV2SelectedScopeAuthority(runState)
      .selected_scopes[0].source_evidence_authority.evidence_id,
    7,
  );
  runState.generic_integrity_selected_scope_authority
    .selected_scopes[0].source_evidence_authority.source_evidence_input_sha256 = "b";
  assert.throws(
    () => canonicalGenericV2SelectedScopeAuthority(runState),
    /persisted source authority is invalid/,
  );
});
