import assert from "node:assert/strict";
import test from "node:test";

import {
  SOS_LIGHT_V2_STAGING_CONTRACT,
  SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
  computeCoordinatorTransitionStateFingerprint,
  requireSosLightV2CoordinatorFreeze,
} from "../scripts/backup_r2/lib/sos_light_v2_coordinator_validation.mjs";


function fixture() {
  const childKey = "history/v2/observations/day_utc=2026-01-01/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const parentKey = "history/v2/observations/day_utc=2026-01-01/connector_id=1/pollutant_code=no2/manifest.json";
  const objects = {
    [childKey]: {
      object_key: childKey,
      local_path: "/run/part.parquet",
      sha256: "a".repeat(64),
      bytes: 10,
      stage: "observations_data",
      dependencies: [],
      dependency_identities: {},
      proposed: true,
      built: true,
      structurally_validated: true,
      changed: true,
      included_in_write_set: true,
      status: "planned",
      planner_changed: true,
      planner_status: "planned",
      planner_included_in_write_set: true,
      planner_dependencies: [],
      planner_dependency_identities: {},
    },
    [parentKey]: {
      object_key: parentKey,
      local_path: "/run/manifest.json",
      sha256: "b".repeat(64),
      bytes: 20,
      stage: "pollutant_manifest",
      dependencies: [childKey],
      dependency_identities: {
        [childKey]: { sha256: "a".repeat(64), bytes: 10, source: "planned_overlay" },
      },
      proposed: true,
      built: true,
      structurally_validated: true,
      changed: true,
      included_in_write_set: true,
      status: "planned",
      planner_changed: true,
      planner_status: "planned",
      planner_included_in_write_set: true,
      planner_dependencies: [childKey],
      planner_dependency_identities: {
        [childKey]: { sha256: "a".repeat(64), bytes: 10, source: "planned_overlay" },
      },
    },
  };
  const state = {
    environment: "TEST",
    execution_path: "sos_light",
    mode: "sos-light",
    dedicated_sos_historical_replacement: true,
    mutation_connector_ids: [1],
    selected_mutation_connector_ids: [1],
    protected_connector_ids: [1],
    objects,
    tombstone_prefixes: [{
      prefix: "history/v2/observations/day_utc=2026-01-01",
      proposed: true,
    }],
    proposal_transition_planner_unchanged_keys: [],
    final_staged_write_set_provenance: {
      status: "finalised",
      final_staged_object_count: 2,
      forced_republication_count: 0,
      forced_republication_keys: [],
      promotion_reason_counts: { exact_prefix_replacement: 0 },
      rebuilt_dependency_identity_count: 0,
      staged_dependency_edge_count: 1,
      external_dependency_edge_counts: { dropbox: 0, overlay: 0 },
    },
    sos_light_v2_proposal_staging: {
      contract_version: SOS_LIGHT_V2_STAGING_CONTRACT,
      status: "complete",
      completed_object_count: 2,
      total_object_count: 2,
      checkpoint_count: 1,
      changed_scope_count: 1,
      final_provenance_status: "complete",
      python_transition_validation_status: "succeeded",
      persisted_state_equality_status: "succeeded",
      node_apply_launch_permitted: true,
    },
    proposal_transition_validation: {
      status: "succeeded",
      node_apply_launch_permitted: true,
      state_fingerprint_contract_version:
        SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    },
  };
  state.proposal_transition_validation.state_fingerprint_sha256 =
    computeCoordinatorTransitionStateFingerprint(state);
  return { state, childKey, parentKey };
}

test("dedicated v2 accepts an independently recomputed frozen fingerprint", () => {
  const { state } = fixture();
  const result = requireSosLightV2CoordinatorFreeze(state);
  assert.equal(result.dedicated, true);
  assert.equal(result.status, "accepted");
});

test("dedicated identity is bound into the transition fingerprint", () => {
  const { state } = fixture();
  const fingerprint = state.proposal_transition_validation.state_fingerprint_sha256;
  state.environment = "LIVE";
  assert.notEqual(computeCoordinatorTransitionStateFingerprint(state), fingerprint);
  assert.throws(
    () => requireSosLightV2CoordinatorFreeze(state),
    /transition evidence is stale or changed/,
  );
});

test("fixed-v2 evidence cannot be downgraded by removing dedicated identity", () => {
  for (const mutate of [
    (state) => {
      delete state.execution_path;
      delete state.mode;
      delete state.dedicated_sos_historical_replacement;
    },
    (state) => { state.mode = "generic"; },
    (state) => { state.protected_connector_ids = []; },
  ]) {
    const { state } = fixture();
    mutate(state);
    assert.throws(
      () => requireSosLightV2CoordinatorFreeze(state),
      /evidence requires the complete dedicated coordinator identity/,
    );
  }
});

test("dependency identity tampering invalidates stale transition evidence", () => {
  const { state, childKey, parentKey } = fixture();
  state.objects[parentKey].dependency_identities[childKey].source = "dropbox";
  assert.throws(
    () => requireSosLightV2CoordinatorFreeze(state),
    /transition evidence is stale or changed/,
  );
});

test("planner and final-provenance tampering invalidate stale evidence", () => {
  const plannerTampered = fixture();
  plannerTampered.state.objects[plannerTampered.parentKey].planner_status = "changed";
  assert.throws(
    () => requireSosLightV2CoordinatorFreeze(plannerTampered.state),
    /transition evidence is stale or changed/,
  );

  const provenanceTampered = fixture();
  provenanceTampered.state.final_staged_write_set_provenance.rebuilt_dependency_identity_count = 1;
  assert.throws(
    () => requireSosLightV2CoordinatorFreeze(provenanceTampered.state),
    /transition evidence is stale or changed/,
  );
});

test("missing unknown and malformed fingerprints fail closed", () => {
  for (const mutate of [
    (state) => { delete state.proposal_transition_validation.state_fingerprint_sha256; },
    (state) => { state.proposal_transition_validation.state_fingerprint_contract_version = "unknown"; },
    (state) => { state.proposal_transition_validation.state_fingerprint_sha256 = "not-a-sha"; },
  ]) {
    const { state } = fixture();
    mutate(state);
    assert.throws(() => requireSosLightV2CoordinatorFreeze(state));
  }
});

test("an incomplete staging checkpoint fails closed", () => {
  const { state } = fixture();
  state.sos_light_v2_proposal_staging.status = "in_progress";
  state.sos_light_v2_proposal_staging.node_apply_launch_permitted = false;
  assert.throws(
    () => requireSosLightV2CoordinatorFreeze(state),
    /staging checkpoint is incomplete/,
  );
});

test("generic non-SOS v2 remains compatible without coordinator evidence", () => {
  assert.deepEqual(
    requireSosLightV2CoordinatorFreeze({ environment: "TEST", objects: {} }),
    { dedicated: false },
  );
});
