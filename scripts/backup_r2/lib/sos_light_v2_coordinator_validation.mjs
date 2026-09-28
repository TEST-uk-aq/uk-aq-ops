import crypto from "node:crypto";

export const SOS_LIGHT_V2_STAGING_CONTRACT =
  "uk_aq_sos_light_v2_coordinator_staging_v1";
export const SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT =
  "uk_aq_sos_light_v2_transition_state_fingerprint_v2";

const SHA256 = /^[a-f0-9]{64}$/;
const DEPENDENCY_SOURCES = new Set(["planned_overlay", "dropbox", "overlay"]);

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function safeKey(rawKey) {
  const key = String(rawKey || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => part === "..")) {
    throw new Error(`Fixed-v2 transition fingerprint key is invalid: ${rawKey}`);
  }
  return key;
}

function recursivelySortJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => recursivelySortJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(bytewiseCompare)
      .map((key) => [key, recursivelySortJsonValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(recursivelySortJsonValue(value));
}

function optionalBoolean(entry, field, label) {
  const value = entry?.[field];
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    throw new Error(`Fixed-v2 transition fingerprint boolean is invalid: ${label}:${field}`);
  }
  return value ?? null;
}

function optionalText(entry, field, label) {
  const value = entry?.[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`Fixed-v2 transition fingerprint text is invalid: ${label}:${field}`);
  }
  return value ?? null;
}

function nonnegativeInteger(entry, field, label) {
  const value = entry?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Fixed-v2 transition fingerprint count is invalid: ${label}:${field}`);
  }
  return value;
}

function connectorIds(runState, field) {
  const rawValues = runState?.[field];
  if (!Array.isArray(rawValues)
      || rawValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Fixed-v2 transition fingerprint connector IDs are invalid: ${field}`);
  }
  const values = [...rawValues].sort((left, right) => left - right);
  if (new Set(values).size !== values.length) {
    throw new Error(`Fixed-v2 transition fingerprint connector IDs are duplicated: ${field}`);
  }
  return values;
}

function operationIdentity(runState) {
  const identity = {};
  for (const field of ["environment", "execution_path", "mode"]) {
    const value = runState?.[field];
    if (typeof value !== "string" || !value) {
      throw new Error(`Fixed-v2 transition fingerprint operation identity is invalid: ${field}`);
    }
    identity[field] = value;
  }
  if (typeof runState?.dedicated_sos_historical_replacement !== "boolean") {
    throw new Error(
      "Fixed-v2 transition fingerprint operation identity is invalid: "
      + "dedicated_sos_historical_replacement",
    );
  }
  identity.dedicated_sos_historical_replacement =
    runState.dedicated_sos_historical_replacement;
  for (const field of [
    "mutation_connector_ids",
    "selected_mutation_connector_ids",
    "protected_connector_ids",
  ]) {
    identity[field] = connectorIds(runState, field);
  }
  return identity;
}

function identityEntries(parentKey, rawIdentities, label) {
  if (rawIdentities === undefined || rawIdentities === null) return null;
  if (!rawIdentities || typeof rawIdentities !== "object" || Array.isArray(rawIdentities)) {
    throw new Error(`Fixed-v2 transition fingerprint ${label} is invalid: ${parentKey}`);
  }
  return Object.entries(rawIdentities).map(([rawDependencyKey, rawIdentity]) => {
    const dependencyKey = safeKey(rawDependencyKey);
    if (rawDependencyKey !== dependencyKey
        || !rawIdentity || typeof rawIdentity !== "object" || Array.isArray(rawIdentity)
        || !SHA256.test(String(rawIdentity.sha256 || ""))
        || !Number.isSafeInteger(rawIdentity.bytes) || rawIdentity.bytes < 0
        || !DEPENDENCY_SOURCES.has(rawIdentity.source)) {
      throw new Error(
        `Fixed-v2 transition fingerprint ${label} entry is invalid: ${parentKey} -> ${rawDependencyKey}`,
      );
    }
    return {
      object_key: dependencyKey,
      sha256: rawIdentity.sha256,
      bytes: rawIdentity.bytes,
      source: rawIdentity.source,
    };
  }).sort((left, right) => bytewiseCompare(left.object_key, right.object_key));
}

function canonicalStringSet(raw, label, { prefixes = false } = {}) {
  if (!Array.isArray(raw)) throw new Error(`Fixed-v2 transition fingerprint ${label} is invalid`);
  const values = raw.map((value) => {
    const key = safeKey(value);
    return prefixes ? key.replace(/\/+$/, "") : key;
  });
  return [...new Set(values)].sort(bytewiseCompare);
}

function canonicalCountMap(raw, label) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Fixed-v2 transition fingerprint ${label} is invalid`);
  }
  return Object.fromEntries(Object.keys(raw).sort(bytewiseCompare)
    .map((key) => [String(key), nonnegativeInteger(raw, key, label)]));
}

export function coordinatorTransitionStateFingerprintPayload(runState) {
  const rawObjects = runState?.objects;
  if (!rawObjects || typeof rawObjects !== "object" || Array.isArray(rawObjects)) {
    throw new Error("Fixed-v2 transition fingerprint objects mapping is invalid");
  }
  const objects = Object.entries(rawObjects).map(([rawObjectKey, entry]) => {
    const objectKey = safeKey(rawObjectKey);
    if (rawObjectKey !== objectKey || !entry || typeof entry !== "object" || Array.isArray(entry)
        || !SHA256.test(String(entry.sha256 || ""))
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !Array.isArray(entry.dependencies)) {
      throw new Error(`Fixed-v2 transition fingerprint object is invalid: ${rawObjectKey}`);
    }
    const dependencies = canonicalStringSet(entry.dependencies, `dependencies:${objectKey}`);
    if (dependencies.length !== entry.dependencies.length) {
      throw new Error(`Fixed-v2 transition fingerprint dependencies are duplicated: ${objectKey}`);
    }
    let plannerDependencies = null;
    if (entry.planner_dependencies !== undefined && entry.planner_dependencies !== null) {
      plannerDependencies = canonicalStringSet(
        entry.planner_dependencies, `planner_dependencies:${objectKey}`,
      );
      if (plannerDependencies.length !== entry.planner_dependencies.length) {
        throw new Error(
          `Fixed-v2 transition fingerprint planner dependencies are duplicated: ${objectKey}`,
        );
      }
    }
    return {
      object_key: objectKey,
      sha256: entry.sha256,
      bytes: entry.bytes,
      stage: optionalText(entry, "stage", objectKey),
      dependencies,
      dependency_identities: identityEntries(
        objectKey, entry.dependency_identities, "dependency identities",
      ),
      proposed: optionalBoolean(entry, "proposed", objectKey),
      built: optionalBoolean(entry, "built", objectKey),
      structurally_validated: optionalBoolean(entry, "structurally_validated", objectKey),
      changed: optionalBoolean(entry, "changed", objectKey),
      included_in_write_set: optionalBoolean(entry, "included_in_write_set", objectKey),
      status: optionalText(entry, "status", objectKey),
      planner_changed: optionalBoolean(entry, "planner_changed", objectKey),
      planner_status: optionalText(entry, "planner_status", objectKey),
      planner_included_in_write_set: optionalBoolean(
        entry, "planner_included_in_write_set", objectKey,
      ),
      planner_dependencies: plannerDependencies,
      planner_dependency_identities: identityEntries(
        objectKey, entry.planner_dependency_identities, "planner dependency identities",
      ),
      proposal_changed: optionalBoolean(entry, "proposal_changed", objectKey),
      planner_source: optionalText(entry, "planner_source", objectKey),
      baseline_source: optionalText(entry, "baseline_source", objectKey),
      included_in_final_staged_write_set: optionalBoolean(
        entry, "included_in_final_staged_write_set", objectKey,
      ),
      promotion_reason: optionalText(entry, "promotion_reason", objectKey),
      final_source: optionalText(entry, "final_source", objectKey),
    };
  }).sort((left, right) => bytewiseCompare(left.object_key, right.object_key));

  const proposedPrefixes = canonicalStringSet(
    (runState?.tombstone_prefixes || [])
      .filter((entry) => entry && typeof entry === "object" && entry.proposed)
      .map((entry) => entry.prefix),
    "tombstone prefixes",
    { prefixes: true },
  );
  const provenance = runState?.final_staged_write_set_provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)
      || !Array.isArray(provenance.forced_republication_keys)) {
    throw new Error("Fixed-v2 transition fingerprint final provenance is invalid");
  }
  return {
    contract_version: SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    operation_identity: operationIdentity(runState),
    objects,
    proposal_transition_planner_unchanged_keys: canonicalStringSet(
      runState?.proposal_transition_planner_unchanged_keys || [],
      "unchanged-planner keys",
    ),
    proposed_tombstone_prefixes: proposedPrefixes,
    final_staged_write_set_provenance: {
      status: optionalText(provenance, "status", "final_staged_write_set_provenance"),
      final_staged_object_count: nonnegativeInteger(
        provenance, "final_staged_object_count", "final_staged_write_set_provenance",
      ),
      forced_republication_count: nonnegativeInteger(
        provenance, "forced_republication_count", "final_staged_write_set_provenance",
      ),
      forced_republication_keys: canonicalStringSet(
        provenance.forced_republication_keys, "forced-republication keys",
      ),
      promotion_reason_counts: canonicalCountMap(
        provenance.promotion_reason_counts, "promotion_reason_counts",
      ),
      rebuilt_dependency_identity_count: nonnegativeInteger(
        provenance, "rebuilt_dependency_identity_count", "final_staged_write_set_provenance",
      ),
      staged_dependency_edge_count: nonnegativeInteger(
        provenance, "staged_dependency_edge_count", "final_staged_write_set_provenance",
      ),
      external_dependency_edge_counts: canonicalCountMap(
        provenance.external_dependency_edge_counts, "external_dependency_edge_counts",
      ),
    },
  };
}

export function computeCoordinatorTransitionStateFingerprint(runState) {
  return crypto.createHash("sha256")
    .update(Buffer.from(canonicalJson(coordinatorTransitionStateFingerprintPayload(runState)), "utf8"))
    .digest("hex");
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function hasOwn(value, field) {
  return Boolean(value && typeof value === "object"
    && Object.prototype.hasOwnProperty.call(value, field));
}

function hasFixedV2Evidence(runState) {
  const transition = runState?.proposal_transition_validation;
  const audit = runState?.sos_light;
  const tombstoneEvidence = Array.isArray(runState?.tombstone_prefixes)
    && runState.tombstone_prefixes.some((entry) => entry?.stage === "sos_light_complete_day"
      || hasOwn(entry, "replacement_authorities"));
  const objectEvidence = Object.values(runState?.objects || {}).some((entry) =>
    entry?.stage === "sos_light_dropbox_baseline"
      || entry?.proposal_owner === "dropbox_day_baseline"
      || entry?.local_dependency_snapshot?.source === "complete_local_sos_light_assembly");
  const auditEvidence = [
    "validation_status",
    "complete_day_count",
    "complete_day_deletion_count",
    "no_old_live_r2_body_planning_or_preservation",
  ].some((field) => hasOwn(audit, field));
  return hasOwn(runState, "sos_light_v2_proposal_staging")
    || hasOwn(transition, "state_fingerprint_contract_version")
    || hasOwn(transition, "state_fingerprint_sha256")
    || tombstoneEvidence
    || objectEvidence
    || auditEvidence;
}

export function requireSosLightV2CoordinatorFreeze(runState) {
  const hasSosIdentity = runState?.execution_path === "sos_light"
    || runState?.mode === "sos-light"
    || runState?.dedicated_sos_historical_replacement === true;
  const hasSosEvidence = hasFixedV2Evidence(runState);
  if (!hasSosIdentity && !hasSosEvidence) return { dedicated: false };
  if (runState?.execution_path !== "sos_light" || runState?.mode !== "sos-light"
      || runState?.dedicated_sos_historical_replacement !== true
      || !["TEST", "LIVE"].includes(runState?.environment)
      || !exactArray(runState?.mutation_connector_ids, [1])
      || !exactArray(runState?.selected_mutation_connector_ids, [1])
      || !exactArray(runState?.protected_connector_ids, [1])) {
    throw new Error(
      "Fixed-v2 SOS-light evidence requires the complete dedicated coordinator identity",
    );
  }
  const staging = runState.sos_light_v2_proposal_staging;
  const objectCount = Object.keys(runState?.objects || {}).length;
  if (staging?.contract_version !== SOS_LIGHT_V2_STAGING_CONTRACT
      || staging?.status !== "complete"
      || staging?.node_apply_launch_permitted !== true
      || staging?.python_transition_validation_status !== "succeeded"
      || staging?.persisted_state_equality_status !== "succeeded"
      || staging?.final_provenance_status !== "complete"
      || !Number.isSafeInteger(staging?.completed_object_count)
      || staging.completed_object_count !== staging?.total_object_count
      || staging.completed_object_count !== objectCount) {
    throw new Error("Fixed-v2 SOS-light proposal staging checkpoint is incomplete");
  }
  const provenance = runState.final_staged_write_set_provenance;
  if (provenance?.status !== "finalised"
      || provenance?.final_staged_object_count !== objectCount) {
    throw new Error("Fixed-v2 SOS-light final staged write-set provenance is incomplete");
  }
  const transition = runState.proposal_transition_validation;
  if (transition?.status !== "succeeded"
      || transition?.node_apply_launch_permitted !== true) {
    throw new Error("Fixed-v2 SOS-light coordinator transition validation is not frozen");
  }
  if (transition?.state_fingerprint_contract_version === undefined
      || transition?.state_fingerprint_sha256 === undefined) {
    throw new Error("Fixed-v2 SOS-light coordinator transition-state fingerprint is missing");
  }
  if (transition.state_fingerprint_contract_version
      !== SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT) {
    throw new Error("Fixed-v2 SOS-light coordinator transition-state fingerprint contract is unknown");
  }
  if (!SHA256.test(String(transition.state_fingerprint_sha256 || ""))) {
    throw new Error("Fixed-v2 SOS-light coordinator transition-state fingerprint is invalid");
  }
  const actualFingerprint = computeCoordinatorTransitionStateFingerprint(runState);
  if (actualFingerprint !== transition.state_fingerprint_sha256) {
    throw new Error("Fixed-v2 SOS-light coordinator transition evidence is stale or changed");
  }
  return {
    dedicated: true,
    status: "accepted",
    contract_version: SOS_LIGHT_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    state_fingerprint_sha256: actualFingerprint,
  };
}
