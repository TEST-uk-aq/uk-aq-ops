/** Fixed-v3, SOS-light-only proposal validation boundary. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  loadImmutableSourcePartition,
} from "../uk_aq_apply_integrity_proposal.mjs";

const OBSERVATIONS_PREFIX = "history/v3/observations";
const INDEX_PREFIX = "history/_index_v3";
const V2_OBSERVATIONS_PREFIX = "history/v2/observations";
const V2_INDEX_PREFIX = "history/_index_v2";
const DAY_PREFIX = /^history\/v3\/observations\/day_utc=(\d{4}-\d{2}-\d{2})$/;
const EXACT_SCOPE_PREFIX = /^history\/_index_v3\/observations_timeseries\/(?:_aligned\/)?day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
const POLLUTANT_PREFIX = /^history\/v3\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
const POLLUTANT_MANIFEST = new RegExp(`${POLLUTANT_PREFIX.source.slice(1, -1)}\\/manifest\\.json$`);
const SHA256 = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT =
  "uk_aq_sos_light_v3_transition_state_fingerprint_v1";

function sha256(body) { return createHash("sha256").update(body).digest("hex"); }
function safeKey(raw) {
  const key = String(raw || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe fixed-v3 proposal key: ${String(raw)}`);
  }
  return key;
}
function validDay(day) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return DAY.test(day) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}
function exactArray(value, expected) { return JSON.stringify(value) === JSON.stringify(expected); }
function localBody(runState, entry, key) {
  const localPath = String(entry?.local_path || "");
  const overlayRoot = path.resolve(String(runState?.overlay_root || ""));
  const resolvedLocalPath = path.resolve(localPath);
  const expectedLocalPath = path.resolve(overlayRoot, ...key.split("/"));
  const relative = path.relative(overlayRoot, resolvedLocalPath);
  if (!entry?.proposed || !entry?.built || !entry?.structurally_validated
      || !relative || relative.startsWith("..") || path.isAbsolute(relative)
      || resolvedLocalPath !== expectedLocalPath
      || fs.lstatSync(resolvedLocalPath, { throwIfNoEntry: false })?.isSymbolicLink()
      || !fs.statSync(resolvedLocalPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Fixed-v3 staged object is not structurally validated: ${key}`);
  }
  const body = fs.readFileSync(resolvedLocalPath);
  if (!Number.isSafeInteger(Number(entry.bytes)) || body.byteLength !== Number(entry.bytes)
      || !SHA256.test(String(entry.sha256 || "")) || sha256(body) !== entry.sha256) {
    throw new Error(`Fixed-v3 staged object identity changed: ${key}`);
  }
  return { localPath: resolvedLocalPath, body };
}
function validateDependencies(runState, key, entry) {
  if (!Array.isArray(entry.dependencies)) throw new Error(`Fixed-v3 dependencies are not an array: ${key}`);
  const dependencies = entry.dependencies.map(safeKey);
  if (new Set(dependencies).size !== dependencies.length) throw new Error(`Fixed-v3 dependencies are duplicated: ${key}`);
  const identities = entry.dependency_identities;
  if (!identities || typeof identities !== "object" || Array.isArray(identities)
      || !exactArray(Object.keys(identities).sort(), [...dependencies].sort())) {
    throw new Error(`Fixed-v3 dependency identities are not exact: ${key}`);
  }
  for (const dependencyKey of dependencies) {
    const identity = identities[dependencyKey];
    if (!identity || !SHA256.test(String(identity.sha256 || ""))
        || !Number.isSafeInteger(Number(identity.bytes)) || Number(identity.bytes) < 0) {
      throw new Error(`Fixed-v3 dependency identity is invalid: ${key} -> ${dependencyKey}`);
    }
    const staged = runState.objects?.[dependencyKey];
    if (!staged) {
      throw new Error(`Fixed-v3 dependency is outside the frozen proposal: ${key} -> ${dependencyKey}`);
    }
    const { body } = localBody(runState, staged, dependencyKey);
    if (identity.source !== "planned_overlay" || body.byteLength !== Number(identity.bytes)
        || sha256(body) !== identity.sha256) {
      throw new Error(`Fixed-v3 current-run dependency identity is invalid: ${key} -> ${dependencyKey}`);
    }
  }
}

function optionalFingerprintBoolean(entry, field, label) {
  const value = entry?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new Error(`Fixed-v3 transition fingerprint boolean is invalid: ${label}:${field}`);
  }
  return value;
}

function optionalFingerprintText(entry, field, label) {
  const value = entry?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Fixed-v3 transition fingerprint text is invalid: ${label}:${field}`);
  }
  return value;
}

function nonnegativeFingerprintInteger(entry, field, label) {
  const value = entry?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Fixed-v3 transition fingerprint count is invalid: ${label}:${field}`);
  }
  return value;
}

function fingerprintIdentityEntries(rawIdentities, parentKey, label) {
  if (rawIdentities === undefined || rawIdentities === null) return null;
  if (typeof rawIdentities !== "object" || Array.isArray(rawIdentities)) {
    throw new Error(`Fixed-v3 transition fingerprint ${label} is invalid: ${parentKey}`);
  }
  return Object.entries(rawIdentities).map(([rawDependencyKey, rawIdentity]) => {
    const dependencyKey = safeKey(rawDependencyKey);
    if (rawDependencyKey !== dependencyKey) {
      throw new Error(`Fixed-v3 transition fingerprint dependency key is not canonical: ${parentKey} -> ${rawDependencyKey}`);
    }
    if (!rawIdentity || typeof rawIdentity !== "object" || Array.isArray(rawIdentity)) {
      throw new Error(`Fixed-v3 transition fingerprint ${label} entry is invalid: ${parentKey} -> ${dependencyKey}`);
    }
    const identitySha256 = String(rawIdentity.sha256 || "").trim().toLowerCase();
    const identityBytes = Number(rawIdentity.bytes);
    const identitySource = String(rawIdentity.source || "").trim();
    if (!SHA256.test(identitySha256)
        || !Number.isSafeInteger(identityBytes) || identityBytes < 0
        || !["planned_overlay", "dropbox", "overlay"].includes(identitySource)) {
      throw new Error(`Fixed-v3 transition fingerprint ${label} entry is invalid: ${parentKey} -> ${dependencyKey}`);
    }
    return {
      object_key: dependencyKey,
      sha256: identitySha256,
      bytes: identityBytes,
      source: identitySource,
    };
  }).sort(compareFingerprintObjectKeys);
}

function canonicalCountMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Fixed-v3 transition fingerprint ${label} is invalid`);
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    nonnegativeFingerprintInteger(value, key, label),
  ]));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Fixed-v3 transition fingerprint number is invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Fixed-v3 transition fingerprint value is invalid");
}

function compareFingerprintObjectKeys(left, right) {
  if (left.object_key < right.object_key) return -1;
  if (left.object_key > right.object_key) return 1;
  return 0;
}

export function coordinatorTransitionStateFingerprintPayload(runState) {
  const rawObjects = runState?.objects;
  if (!rawObjects || typeof rawObjects !== "object" || Array.isArray(rawObjects)) {
    throw new Error("Fixed-v3 transition fingerprint objects mapping is invalid");
  }
  const objects = Object.entries(rawObjects).map(([rawObjectKey, entry]) => {
    const objectKey = safeKey(rawObjectKey);
    if (rawObjectKey !== objectKey) {
      throw new Error(`Fixed-v3 transition fingerprint object key is not canonical: ${rawObjectKey}`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Fixed-v3 transition fingerprint object is invalid: ${objectKey}`);
    }
    const objectSha256 = String(entry.sha256 || "").trim().toLowerCase();
    if (!SHA256.test(objectSha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`Fixed-v3 transition fingerprint object identity is invalid: ${objectKey}`);
    }
    if (!Array.isArray(entry.dependencies)) {
      throw new Error(`Fixed-v3 transition fingerprint dependencies are invalid: ${objectKey}`);
    }
    const dependencies = [...new Set(entry.dependencies.map(safeKey))].sort();
    if (dependencies.length !== entry.dependencies.length) {
      throw new Error(`Fixed-v3 transition fingerprint dependencies are duplicated: ${objectKey}`);
    }
    let plannerDependencies = null;
    if (entry.planner_dependencies !== undefined && entry.planner_dependencies !== null) {
      if (!Array.isArray(entry.planner_dependencies)) {
        throw new Error(`Fixed-v3 transition fingerprint planner dependencies are invalid: ${objectKey}`);
      }
      plannerDependencies = [...new Set(entry.planner_dependencies.map(safeKey))].sort();
      if (plannerDependencies.length !== entry.planner_dependencies.length) {
        throw new Error(`Fixed-v3 transition fingerprint planner dependencies are duplicated: ${objectKey}`);
      }
    }
    return {
      object_key: objectKey,
      sha256: objectSha256,
      bytes: entry.bytes,
      stage: optionalFingerprintText(entry, "stage", objectKey),
      dependencies,
      dependency_identities: fingerprintIdentityEntries(
        entry.dependency_identities, objectKey, "dependency identities",
      ),
      proposed: optionalFingerprintBoolean(entry, "proposed", objectKey),
      built: optionalFingerprintBoolean(entry, "built", objectKey),
      structurally_validated: optionalFingerprintBoolean(
        entry, "structurally_validated", objectKey,
      ),
      changed: optionalFingerprintBoolean(entry, "changed", objectKey),
      included_in_write_set: optionalFingerprintBoolean(
        entry, "included_in_write_set", objectKey,
      ),
      status: optionalFingerprintText(entry, "status", objectKey),
      planner_changed: optionalFingerprintBoolean(entry, "planner_changed", objectKey),
      planner_status: optionalFingerprintText(entry, "planner_status", objectKey),
      planner_included_in_write_set: optionalFingerprintBoolean(
        entry, "planner_included_in_write_set", objectKey,
      ),
      planner_dependencies: plannerDependencies,
      planner_dependency_identities: fingerprintIdentityEntries(
        entry.planner_dependency_identities, objectKey, "planner dependency identities",
      ),
      proposal_changed: optionalFingerprintBoolean(entry, "proposal_changed", objectKey),
      planner_source: optionalFingerprintText(entry, "planner_source", objectKey),
      baseline_source: optionalFingerprintText(entry, "baseline_source", objectKey),
      included_in_final_staged_write_set: optionalFingerprintBoolean(
        entry, "included_in_final_staged_write_set", objectKey,
      ),
      promotion_reason: optionalFingerprintText(entry, "promotion_reason", objectKey),
      final_source: optionalFingerprintText(entry, "final_source", objectKey),
    };
  }).sort(compareFingerprintObjectKeys);

  const rawUnchangedKeys = runState?.proposal_transition_planner_unchanged_keys || [];
  if (!Array.isArray(rawUnchangedKeys)) {
    throw new Error("Fixed-v3 transition fingerprint unchanged-planner keys are invalid");
  }
  const unchangedKeys = [...new Set(rawUnchangedKeys.map(safeKey))].sort();
  const rawTombstones = runState?.tombstone_prefixes || [];
  if (!Array.isArray(rawTombstones)) {
    throw new Error("Fixed-v3 transition fingerprint tombstone prefixes are invalid");
  }
  const proposedPrefixes = [...new Set(rawTombstones
    .filter((entry) => entry && typeof entry === "object" && entry.proposed)
    .map((entry) => safeKey(entry.prefix).replace(/\/+$/, "")))].sort();
  const provenance = runState?.final_staged_write_set_provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("Fixed-v3 transition fingerprint final provenance is invalid");
  }
  if (!Array.isArray(provenance.forced_republication_keys)) {
    throw new Error("Fixed-v3 transition fingerprint forced-republication keys are invalid");
  }
  return {
    contract_version: SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    objects,
    proposal_transition_planner_unchanged_keys: unchangedKeys,
    proposed_tombstone_prefixes: proposedPrefixes,
    final_staged_write_set_provenance: {
      status: optionalFingerprintText(
        provenance, "status", "final_staged_write_set_provenance",
      ),
      final_staged_object_count: nonnegativeFingerprintInteger(
        provenance, "final_staged_object_count", "final_staged_write_set_provenance",
      ),
      forced_republication_count: nonnegativeFingerprintInteger(
        provenance, "forced_republication_count", "final_staged_write_set_provenance",
      ),
      forced_republication_keys: [...new Set(
        provenance.forced_republication_keys.map(safeKey),
      )].sort(),
      promotion_reason_counts: canonicalCountMap(
        provenance.promotion_reason_counts, "promotion_reason_counts",
      ),
      rebuilt_dependency_identity_count: nonnegativeFingerprintInteger(
        provenance, "rebuilt_dependency_identity_count", "final_staged_write_set_provenance",
      ),
      staged_dependency_edge_count: nonnegativeFingerprintInteger(
        provenance, "staged_dependency_edge_count", "final_staged_write_set_provenance",
      ),
      external_dependency_edge_counts: canonicalCountMap(
        provenance.external_dependency_edge_counts, "external_dependency_edge_counts",
      ),
    },
  };
}

export function computeCoordinatorTransitionStateFingerprint(runState) {
  const payload = coordinatorTransitionStateFingerprintPayload(runState);
  return sha256(Buffer.from(canonicalJson(payload), "utf8"));
}

export function requireCoordinatorProposalFreeze(runState) {
  const ingestion = runState?.proposal_ingestion;
  const finalProvenance = runState?.final_staged_write_set_provenance;
  const transition = runState?.proposal_transition_validation;
  if (ingestion?.status !== "complete"
      || ingestion?.transport_mode !== "file_backed_compact_proposal"
      || ingestion?.node_apply_launch_permitted !== false
      || !Number.isSafeInteger(Number(ingestion?.completed_object_count))
      || Number(ingestion.completed_object_count) !== Number(ingestion?.total_object_count)) {
    throw new Error("Fixed-v3 proposal ingestion checkpoint is incomplete");
  }
  if (finalProvenance?.status !== "finalised"
      || Number(finalProvenance?.final_staged_object_count)
        !== Object.keys(runState?.objects || {}).length) {
    throw new Error("Fixed-v3 final staged write-set provenance is incomplete");
  }
  if (transition?.status !== "succeeded"
      || transition?.node_apply_launch_permitted !== true) {
    throw new Error("Fixed-v3 coordinator transition validation is not frozen");
  }
  if (transition?.state_fingerprint_contract_version === undefined
      || transition?.state_fingerprint_sha256 === undefined) {
    throw new Error("Fixed-v3 coordinator transition-state fingerprint is missing");
  }
  if (transition.state_fingerprint_contract_version
      !== SOS_LIGHT_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT) {
    throw new Error("Fixed-v3 coordinator transition-state fingerprint contract is unknown");
  }
  if (!SHA256.test(String(transition.state_fingerprint_sha256 || ""))) {
    throw new Error("Fixed-v3 coordinator transition-state fingerprint is invalid");
  }
  const actualFingerprint = computeCoordinatorTransitionStateFingerprint(runState);
  if (actualFingerprint !== transition.state_fingerprint_sha256) {
    throw new Error("Fixed-v3 coordinator transition evidence is stale or changed");
  }
}

export function validateDedicatedSosHistoricalProposalV3({ runState, proposal }) {
  if (runState?.execution_path !== "sos_light" || runState.mode !== "sos-light"
      || !["TEST", "LIVE"].includes(runState.environment)
      || !exactArray(runState.mutation_connector_ids, [1])
      || !exactArray(runState.selected_mutation_connector_ids, [1])
      || !exactArray(runState.protected_connector_ids, [1])
      || runState.aqi_policy !== "bypassed_observation_history_only") {
    throw new Error("SOS-light-v3 proposal has invalid execution or connector scope");
  }
  const audit = runState.sos_light;
  if (audit?.mode !== "sos-light" || audit?.validation_status !== "complete_local_days_validated"
      || audit?.old_live_r2_observation_bodies_used !== false
      || audit?.no_old_live_r2_body_planning_or_preservation !== true) {
    throw new Error("SOS-light-v3 proposal has invalid reconstruction authority evidence");
  }
  for (const scope of ["AQILEVELS_CHANGED", "AQI_MANIFESTS_CHANGED", "AQI_INDEXES_CHANGED"]) {
    if ((runState.changed_scopes?.[scope] || []).length) throw new Error("SOS-light-v3 must not mutate AQI");
  }
  const selectedDays = [...new Set((audit.days || []).map((entry) => String(entry?.day_utc || "")))].sort();
  if (!selectedDays.length || selectedDays.some((day) => !validDay(day))) throw new Error("SOS-light-v3 selected days are invalid");
  const deletionDays = proposal.prefixes
    .filter(({ entry }) => entry?.stage === "sos_light_complete_day")
    .map(({ prefix, entry }) => {
    const match = prefix.match(DAY_PREFIX);
    if (!match || entry?.stage !== "sos_light_complete_day") throw new Error(`SOS-light-v3 deletion is not a complete observation day: ${prefix}`);
    return match[1];
  }).sort();
  if (!exactArray(selectedDays, deletionDays)) throw new Error("SOS-light-v3 requires exactly one complete observation-day deletion per selected day");
  const keys = new Set(proposal.objects.map(({ key }) => key));
  for (const day of selectedDays) {
    const root = `${OBSERVATIONS_PREFIX}/day_utc=${day}`;
    if (!keys.has(`${root}/manifest.json`) || !keys.has(`${root}/connector_id=1/manifest.json`)) {
      throw new Error(`SOS-light-v3 assembled day lacks required parents: ${day}`);
    }
  }
  return { dedicated: true, mode: "sos-light", connector_id: 1, selected_days: selectedDays };
}

export function validateLocalSosLightV3Proposal(runState) {
  if (!runState || typeof runState !== "object") throw new Error("SOS-light-v3 run state must be an object");
  requireCoordinatorProposalFreeze(runState);
  const objects = Object.entries(runState.objects || {}).map(([rawKey, entry]) => {
    const key = safeKey(rawKey);
    if (key.startsWith(V2_OBSERVATIONS_PREFIX) || key.startsWith(V2_INDEX_PREFIX)
        || !(key.startsWith(`${OBSERVATIONS_PREFIX}/`) || key.startsWith(`${INDEX_PREFIX}/`))
        || key.includes("/aqilevels/")) throw new Error(`Non-v3 SOS-light proposal key: ${key}`);
    const loaded = localBody(runState, entry, key);
    validateDependencies(runState, key, entry);
    return { key, entry, ...loaded, domain: "observations" };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const prefixes = (runState.tombstone_prefixes || []).map((entry) => {
    const prefix = safeKey(entry?.prefix).replace(/\/+$/, "");
    const validDay = entry?.stage === "sos_light_complete_day" && DAY_PREFIX.test(prefix);
    const validExactScope = entry?.stage === "sos_light_exact_v3_scope_removal"
      && EXACT_SCOPE_PREFIX.test(prefix);
    if (!entry?.proposed || (!validDay && !validExactScope)) {
      throw new Error(`Non-v3 SOS-light deletion prefix: ${prefix}`);
    }
    return { entry, prefix, domain: "observations" };
  }).sort((a, b) => a.prefix.localeCompare(b.prefix));
  if (!objects.length || !prefixes.length) throw new Error("SOS-light-v3 proposal has no complete-day operations");
  const proposal = { objects, prefixes };
  validateDedicatedSosHistoricalProposalV3({ runState, proposal });
  return proposal;
}

export async function validateFinalSosLightV3ProposalGraph({ runState, proposal }) {
  const dedicated = validateDedicatedSosHistoricalProposalV3({ runState, proposal });
  const evidence = runState.source_evidence_partitions;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("SOS-light-v3 immutable source evidence is absent");
  const objects = new Map(proposal.objects.map((object) => [object.key, object]));
  for (const object of proposal.objects.filter(({ key }) => key.endsWith("/manifest.json") && key.includes("/pollutant_code="))) {
    const match = object.key.match(POLLUTANT_MANIFEST);
    if (!match || !dedicated.selected_days.includes(match[1])) {
      throw new Error(`SOS-light-v3 pollutant manifest is outside the selected complete days: ${object.key}`);
    }
    let manifest;
    try { manifest = JSON.parse(object.body.toString("utf8")); }
    catch { throw new Error(`SOS-light-v3 pollutant manifest is invalid JSON: ${object.key}`); }
    const partKeys = (manifest.parquet_object_keys || []).map(String);
    const prefix = object.key.slice(0, -"/manifest.json".length);
    if (!Number.isSafeInteger(Number(manifest.row_count)) || Number(manifest.row_count) < 0
        || partKeys.some((key) => !objects.has(key) || !key.startsWith(`${prefix}/`) || !key.endsWith(".parquet"))) {
      throw new Error(`SOS-light-v3 canonical pollutant partition is structurally incomplete: ${object.key}`);
    }
  }
  const partitions = [];
  for (const [identity] of Object.entries(evidence).sort()) {
    const match = identity.match(/^day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/);
    if (!match || !dedicated.selected_days.includes(match[1]) || Number(match[2]) !== 1) throw new Error(`SOS-light-v3 source evidence scope is invalid: ${identity}`);
    const prefix = `${OBSERVATIONS_PREFIX}/${identity}`;
    const manifestKey = `${prefix}/manifest.json`;
    const manifestObject = objects.get(manifestKey);
    if (!manifestObject || !POLLUTANT_MANIFEST.test(manifestKey)) throw new Error(`SOS-light-v3 canonical pollutant partition is missing: ${identity}`);
    const source = loadImmutableSourcePartition({ runState, dayUtc: match[1], connectorId: 1, pollutantCode: match[3] });
    const manifest = JSON.parse(manifestObject.body.toString("utf8"));
    const partKeys = (manifest.parquet_object_keys || []).map(String);
    if (partKeys.some((key) => !objects.has(key) || !key.startsWith(`${prefix}/`) || !key.endsWith(".parquet"))) {
      throw new Error(`SOS-light-v3 pollutant partition is structurally incomplete: ${identity}`);
    }
    if (Number(manifest.row_count) !== source.rows.length) throw new Error(`SOS-light-v3 source/manifest row count differs: ${identity}`);
    partitions.push({ status: "validated", manifest_key: manifestKey, source_content_hash: source.metadata.observation_content_hash, row_count: source.rows.length });
    manifestObject.entry.final_proposal_graph_validated = true;
  }
  const requestedPollutants = [...new Set((runState.requested_repair_pollutants || []).map((value) => String(value).trim().toLowerCase()))].sort();
  for (const day of dedicated.selected_days) for (const pollutant of requestedPollutants) {
    if (!partitions.some((entry) => entry.manifest_key === `${OBSERVATIONS_PREFIX}/day_utc=${day}/connector_id=1/pollutant_code=${pollutant}/manifest.json`)) {
      throw new Error(`SOS-light-v3 selected day lacks requested canonical pollutant partition: ${day}/${pollutant}`);
    }
  }
  runState.final_proposal_graph_validation = {
    status: "succeeded", selected_partition_count: partitions.length,
    validated_partition_count: partitions.length, partitions,
    parent_and_index_dependencies_validated: true, tombstones_validated: true,
    generation: "v3", completed_at_utc: new Date().toISOString(),
  };
  return runState.final_proposal_graph_validation;
}
