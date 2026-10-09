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
