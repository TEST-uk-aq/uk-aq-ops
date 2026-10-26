/** Generic fixed-v3 selected-scope proposal validation boundary. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  loadImmutableSourcePartition,
  validateFinalProposalGraph,
  validateLocalProposal,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  canonicalTransitionFingerprintJson,
  coordinatorTransitionStateCommonFingerprintPayload,
} from "./sos_light_v3_proposal_validation.mjs";
import { validateOfficialRdataPreservationDependencies } from "./official_rdata_evidence_validation.mjs";
import { validateOfficialRdataV10PreservedOnlyAuthority } from "./official_rdata_v10_validation.mjs";
import { authenticateOfficialRdataPinnedHierarchy } from "./official_rdata_pinned_hierarchy.mjs";

const OFFICIAL_RDATA_TIMESTAMP_MAPPING =
  "rdata_date_beginning_plus_one_hour_to_observed_at_utc";

const SHA256 = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLLUTANTS = new Set(["pm25", "pm10", "no2", "o3"]);
const OUTCOMES = new Set([
  "complete_replacement",
  "authoritative_no_data_replacement",
  "source_artifact_unavailable_preserved",
]);
const POLLUTANT_PREFIX = /^history\/v3\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;

export const GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT =
  "uk_aq_generic_integrity_v3_transition_state_fingerprint_v5";
export const GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT =
  "uk_aq_generic_integrity_v3_selected_scope_authority_v4";
export const GENERIC_V3_OFFICIAL_RDATA_PUBLICATION_AUTHORITY_CONTRACT =
  "uk_aq_generic_v3_official_rdata_publication_authority_v3";

const OFFICIAL_RDATA_V8_FIELDS = [
  "schema_version", "semantic_evidence_contract", "source_adapter", "day_utc",
  "connector_id", "source_file_identities_sha256", "requested_pollutant_set",
  "contract", "evidence_contract_version", "history_generation",
  "source_label_registry_snapshot_content_sha256",
  "authoritative_station_timeseries_mapping_sha256",
  "sos_site_ref_bridge_mapping_identity", "sos_site_ref_bridge_artifact_sha256",
  "observed_property_mapping_sha256", "source_artifact_availability_contract_version",
  "source_artifact_availability_sha256", "preserved_baseline_dependency_contract_version",
  "preserved_baseline_dependency_sha256", "rdata_decoder_contract_version",
  "timestamp_mapping", "observation_content_hash_contract_version",
  "source_evidence_input_sha256", "enumeration_complete", "files_enumerated",
  "files_required", "files_read", "files_authoritatively_absent",
  "source_file_identities", "source_records_examined", "source_csv_records_scanned",
  "canonical_rows_mapped", "missing_binding_groups", "missing_binding_rows",
  "canonical_rows_file", "canonical_rows_sha256", "canonical_rows_bytes", "total_rows",
  "per_timeseries_counts", "per_pollutant_counts", "observation_content_hashes",
  "pollutant_set", "source_available_timeseries_ids", "source_available_pollutant_codes",
  "source_unavailable_timeseries_ids", "source_unavailable_scopes",
  "preserved_baseline_rows_file", "preserved_baseline_rows_sha256",
  "preserved_baseline_rows_bytes", "preserved_baseline_row_count",
  "preserved_baseline_identity", "final_target_row_count",
  "final_target_timeseries_row_counts", "final_target_pollutant_counts",
  "empty_final_target_pollutant_codes", "final_target_observation_content_hashes",
  "source_rows_before_canonical_dedupe", "duplicate_rows_removed_by_canonical_normalisation",
  "duplicate_canonical_row_count", "duplicate_canonical_row_identity_samples",
  "uncanonicalisable_source_row_count", "source_adapter_blocked_row_count",
  "source_adapter_blocked_row_samples", "out_of_scope_source_adapter_blocked_row_count",
  "blocked_row_count", "blocked_row_samples", "skipped_row_count",
  "inactive_identity_rows_skipped", "source_label_classification_counts",
  "source_label_target_day_row_counts", "source_label_summary",
  "source_label_classifications", "mapping_audit", "source_verification_status_counts",
];

function sha256(body) { return createHash("sha256").update(body).digest("hex"); }
function bytewise(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}
function exactArray(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function validDay(day) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return DAY.test(day) && !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === day;
}
function safeKey(raw) {
  const key = String(raw || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe generic fixed-v3 key: ${String(raw)}`);
  }
  return key;
}

function genericV3ValidationRunState(runState, source = null) {
  const authority = runState?.generic_integrity_selected_scope_authority;
  if (runState?.execution_path !== "generic_integrity"
      || runState?.dedicated_sos_historical_replacement !== false
      || (Object.hasOwn(runState, "history_generation")
        && runState.history_generation !== "v3")
      || authority?.contract_version !== GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
      || authority.history_generation !== "v3"
      || (source !== null && source?.evidence?.history_generation !== "v3")) {
    throw new Error("Generic fixed-v3 history generation context is invalid");
  }
  return { ...runState, history_generation: "v3" };
}

function officialRdataSemanticEvidenceSha256(evidence) {
  const allowed = new Set([
    ...OFFICIAL_RDATA_V8_FIELDS, "source_column_classifications_sha256", "source_column_classifications",
    "semantic_evidence_sha256", "acquisition_audit", "acquisition_audit_sha256",
  ]);
  if ([...OFFICIAL_RDATA_V8_FIELDS, "source_column_classifications_sha256", "source_column_classifications"].some((field) => !Object.hasOwn(evidence || {}, field))
      || Object.keys(evidence || {}).some((field) => !allowed.has(field))) {
    throw new Error("Generic fixed-v3 official semantic evidence shape is invalid");
  }
  return sha256(Buffer.from(canonicalTransitionFingerprintJson(
    Object.fromEntries([...OFFICIAL_RDATA_V8_FIELDS, "source_column_classifications_sha256", "source_column_classifications"].map((field) => [field, evidence[field]])),
  ), "utf8"));
}

export function requireGenericV3OfficialRdataAuthority(runState) {
  const sourceAdapter = String(runState?.official_rdata_source_adapter || "");
  const connectorId = { waqn: 9, saqn: 10 }[sourceAdapter];
  const authority = runState?.generic_integrity_selected_scope_authority;
  if (!connectorId || authority?.contract_version
      !== GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
      || authority?.history_generation !== "v3"
      || !Array.isArray(authority?.selected_scopes) || !authority.selected_scopes.length) {
    throw new Error("Generic fixed-v3 official RData selected authority is unavailable");
  }
  const selectedScopeSourceEvidence = authority.selected_scopes.filter((scope) =>
    scope.outcome !== "source_artifact_unavailable_preserved").map((scope) => {
    const dayUtc = String(scope?.day_utc || "");
    const pollutantCode = String(scope?.pollutant_code || "");
    if (scope?.connector_id !== connectorId || !validDay(dayUtc)
        || !POLLUTANTS.has(pollutantCode)) {
      throw new Error("Generic fixed-v3 official RData selected scope is invalid");
    }
    const { evidence } = loadImmutableSourcePartition({
      runState, dayUtc, connectorId, pollutantCode,
    });
    const semanticSha256 = officialRdataSemanticEvidenceSha256(evidence);
    if (evidence.evidence_contract_version !== 10
        || evidence.history_generation !== "v3"
        || evidence.source_adapter !== sourceAdapter
        || evidence.day_utc !== dayUtc
        || evidence.connector_id !== connectorId
        || evidence.timestamp_mapping !== OFFICIAL_RDATA_TIMESTAMP_MAPPING
        || !Array.isArray(evidence.requested_pollutant_set)
        || !evidence.requested_pollutant_set.includes(pollutantCode)
        || evidence.semantic_evidence_sha256 !== semanticSha256
        || !SHA256.test(String(evidence.source_evidence_input_sha256 || ""))
        || !SHA256.test(String(evidence.acquisition_audit_sha256 || ""))) {
      throw new Error("Generic fixed-v3 official RData semantic evidence is invalid");
    }
    return {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      evidence_contract_version: 10,
      source_adapter: sourceAdapter,
      timestamp_mapping: OFFICIAL_RDATA_TIMESTAMP_MAPPING,
      semantic_evidence_sha256: semanticSha256,
      source_evidence_input_sha256: evidence.source_evidence_input_sha256,
      acquisition_audit_sha256: evidence.acquisition_audit_sha256,
      source_file_identities_sha256: evidence.source_file_identities_sha256,
      source_file_identities: evidence.source_file_identities,
      requested_pollutant_set: evidence.requested_pollutant_set,
      files_required: evidence.files_required,
      files_read: evidence.files_read,
      files_authoritatively_absent: evidence.files_authoritatively_absent,
      canonical_rows_sha256: evidence.canonical_rows_sha256,
      canonical_rows_bytes: evidence.canonical_rows_bytes,
      source_artifact_availability_sha256:
        evidence.source_artifact_availability_sha256,
      source_unavailable_scopes: evidence.source_unavailable_scopes,
      preserved_baseline_dependency_sha256:
        evidence.preserved_baseline_dependency_sha256,
      preserved_baseline_identity: evidence.preserved_baseline_identity,
      final_target_row_count: evidence.final_target_row_count,
      final_target_timeseries_row_counts: evidence.final_target_timeseries_row_counts,
      final_target_pollutant_counts: evidence.final_target_pollutant_counts,
      final_target_observation_content_hashes:
        evidence.final_target_observation_content_hashes,
    };
  }).sort((left, right) => bytewise(left.day_utc, right.day_utc)
    || left.connector_id - right.connector_id
    || bytewise(left.pollutant_code, right.pollutant_code));
  return {
    contract_version: GENERIC_V3_OFFICIAL_RDATA_PUBLICATION_AUTHORITY_CONTRACT,
    history_generation: "v3",
    source_adapter: sourceAdapter,
    selected_scope_source_evidence: selectedScopeSourceEvidence,
  };
}

function parsePreservedManifest(body, objectKey) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new Error(`Generic fixed-v3 preserved manifest JSON is invalid: ${objectKey}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Generic fixed-v3 preserved manifest JSON is invalid: ${objectKey}`);
  }
  return payload;
}

function exactManifestReference(payload, fields, parentKey, childKey,
  identityField = "manifest_hash", expectedChildKeys = null) {
  const base = "history/v3/observations";
  const parentPrefix = parentKey.slice(0, -"/manifest.json".length);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern;
  if (fields.includes("pollutant_manifests")) {
    pattern = new RegExp(`^${escape(parentPrefix)}/pollutant_code=[a-z0-9_]+/manifest\\.json$`);
  } else if (fields.includes("connector_manifests")) {
    pattern = new RegExp(`^${escape(parentPrefix)}/connector_id=[1-9]\\d*/manifest\\.json$`);
  } else if (parentKey === `${base}/_manifests/manifest.json`) {
    pattern = new RegExp(`^${escape(base)}/_manifests/year=\\d{4}/manifest\\.json$`);
  } else if (new RegExp(`^${escape(base)}/_manifests/year=\\d{4}/manifest\\.json$`).test(parentKey)) {
    pattern = new RegExp(`^${escape(parentPrefix)}/month=(?:0[1-9]|1[0-2])/manifest\\.json$`);
  } else {
    const month = parentKey.match(new RegExp(`^${escape(base)}/_manifests/year=(\\d{4})/month=(0[1-9]|1[0-2])/manifest\\.json$`));
    if (!month) throw new Error(`Generic fixed-v3 preserved parent path is invalid: ${parentKey}`);
    pattern = new RegExp(`^${escape(base)}/day_utc=${month[1]}-${month[2]}-\\d{2}/manifest\\.json$`);
  }
  const collections = [];
  for (const field of fields) {
    const rawReferences = payload[field];
    if (!Array.isArray(rawReferences)) {
      throw new Error(`Generic fixed-v3 preserved parent references are invalid: ${parentKey}`);
    }
    const references = new Map();
    for (const reference of rawReferences) {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
        throw new Error(`Generic fixed-v3 preserved parent reference is invalid: ${parentKey}`);
      }
      const manifestKey = String(reference.manifest_key || "");
      const manifestHash = String(reference[identityField] || "");
      if (!pattern.test(manifestKey) || !SHA256.test(manifestHash)
          || references.has(manifestKey)) {
        throw new Error(`Generic fixed-v3 preserved parent has invalid child identity: ${parentKey}`);
      }
      references.set(manifestKey, reference);
    }
    collections.push(references);
  }
  const canonical = (collection) => canonicalTransitionFingerprintJson(
    [...collection.entries()].sort(([left], [right]) => bytewise(left, right)),
  );
  if (collections.some((collection) => canonical(collection) !== canonical(collections[0]))) {
    throw new Error(`Generic fixed-v3 preserved parent child aliases disagree: ${parentKey}`);
  }
  if (expectedChildKeys !== null
      && !exactArray([...collections[0].keys()].sort(bytewise), [...expectedChildKeys].sort(bytewise))) {
    throw new Error(`Generic fixed-v3 preserved parent child dependencies disagree: ${parentKey}`);
  }
  const manifestHash = collections[0].get(childKey)?.[identityField];
  if (!SHA256.test(String(manifestHash || ""))) {
    throw new Error(
      `Generic fixed-v3 preserved parent lacks exact child reference: ${parentKey} -> ${childKey}`,
    );
  }
  return manifestHash;
}

function normalizedDependencyIdentity(rawIdentity, parentKey, childKey) {
  const identity = {
    sha256: String(rawIdentity?.sha256 || "").trim().toLowerCase(),
    bytes: rawIdentity?.bytes,
    source: String(rawIdentity?.source || "").trim(),
  };
  if (!SHA256.test(identity.sha256)
      || !Number.isSafeInteger(identity.bytes) || identity.bytes < 0
      || !["planned_overlay", "dropbox", "overlay"].includes(identity.source)) {
    throw new Error(`Generic fixed-v3 dependency identity is invalid: ${parentKey} -> ${childKey}`);
  }
  return identity;
}

function readStagedPreservedManifest(runState, objectKey) {
  const entry = runState?.objects?.[objectKey];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Generic fixed-v3 preserved parent is not staged: ${objectKey}`);
  }
  let body;
  try {
    body = fs.readFileSync(String(entry.local_path || ""));
  } catch {
    throw new Error(`Generic fixed-v3 preserved parent body is unavailable: ${objectKey}`);
  }
  if (body.byteLength !== entry.bytes || sha256(body) !== String(entry.sha256 || "")) {
    throw new Error(`Generic fixed-v3 preserved parent identity changed: ${objectKey}`);
  }
  return { entry, body, payload: parsePreservedManifest(body, objectKey) };
}

function deriveGenericPreservedScopeEvidence(runState, { dayUtc, connectorId, pollutantCode }) {
  const dayPrefix = `history/v3/observations/day_utc=${dayUtc}`;
  const connectorPrefix = `${dayPrefix}/connector_id=${connectorId}`;
  const pollutantPrefix = `${connectorPrefix}/pollutant_code=${pollutantCode}`;
  const pollutantManifestKey = `${pollutantPrefix}/manifest.json`;
  const connectorManifestKey = `${connectorPrefix}/manifest.json`;
  const dayManifestKey = `${dayPrefix}/manifest.json`;
  const connector = readStagedPreservedManifest(runState, connectorManifestKey);
  const day = readStagedPreservedManifest(runState, dayManifestKey);
  if (!Array.isArray(connector.entry.dependencies)
      || !connector.entry.dependencies.includes(pollutantManifestKey)) {
    throw new Error(
      `Generic fixed-v3 preserved connector lacks exact pollutant dependency: ${connectorManifestKey} -> ${pollutantManifestKey}`,
    );
  }
  const pollutantIdentity = normalizedDependencyIdentity(
    connector.entry.dependency_identities?.[pollutantManifestKey],
    connectorManifestKey,
    pollutantManifestKey,
  );
  if (!["dropbox", "overlay"].includes(pollutantIdentity.source)) {
    throw new Error(
      `Generic fixed-v3 preserved pollutant manifest is not externally pinned: ${pollutantManifestKey}`,
    );
  }
  const externalRoot = pollutantIdentity.source === "dropbox"
    ? runState.base_dropbox_root : runState.overlay_root;
  if (!externalRoot || !fs.statSync(String(externalRoot), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Generic fixed-v3 preserved external root is unavailable: ${pollutantIdentity.source}`,
    );
  }
  let pollutantBody;
  try {
    pollutantBody = fs.readFileSync(path.join(String(externalRoot || ""), ...pollutantManifestKey.split("/")));
  } catch {
    throw new Error(`Generic fixed-v3 preserved pollutant manifest is unavailable: ${pollutantManifestKey}`);
  }
  if (pollutantBody.byteLength !== pollutantIdentity.bytes
      || sha256(pollutantBody) !== pollutantIdentity.sha256) {
    throw new Error(`Generic fixed-v3 preserved pollutant manifest identity changed: ${pollutantManifestKey}`);
  }
  if ([9, 10].includes(connectorId)) {
    const pinned = derivePinnedMetadataDependencies(runState, {
      dayUtc, connectorId, pollutantCode,
    }).at(-1);
    if (pinned.sha256 !== pollutantIdentity.sha256
        || pinned.bytes !== pollutantIdentity.bytes) {
      throw new Error(`Generic fixed-v3 preserved official RData child differs from pinned baseline: ${pollutantManifestKey}`);
    }
  }
  const pollutantPayload = parsePreservedManifest(pollutantBody, pollutantManifestKey);
  const pollutantManifestHash = String(pollutantPayload.manifest_hash || "");
  if (!SHA256.test(pollutantManifestHash)) {
    throw new Error(`Generic fixed-v3 preserved pollutant manifest hash is invalid: ${pollutantManifestKey}`);
  }
  const connectorChildHash = exactManifestReference(
    connector.payload,
    ["pollutant_manifests", "child_manifests"],
    connectorManifestKey,
    pollutantManifestKey,
    "manifest_hash",
    connector.entry.dependencies.filter((key) =>
      new RegExp(`^${connectorPrefix}/pollutant_code=[a-z0-9_]+/manifest\\.json$`).test(key)),
  );
  if (connectorChildHash !== pollutantManifestHash) {
    throw new Error(`Generic fixed-v3 connector references stale pollutant identity: ${pollutantManifestKey}`);
  }
  const connectorManifestHash = String(connector.payload.manifest_hash || "");
  if (!SHA256.test(connectorManifestHash)) {
    throw new Error(`Generic fixed-v3 preserved connector manifest hash is invalid: ${connectorManifestKey}`);
  }
  if (!Array.isArray(day.entry.dependencies)
      || !day.entry.dependencies.includes(connectorManifestKey)) {
    throw new Error(
      `Generic fixed-v3 preserved day parent lacks staged connector: ${dayManifestKey} -> ${connectorManifestKey}`,
    );
  }
  const connectorIdentity = normalizedDependencyIdentity(
    day.entry.dependency_identities?.[connectorManifestKey],
    dayManifestKey,
    connectorManifestKey,
  );
  if (!exactArray(
    [connectorIdentity.sha256, connectorIdentity.bytes, connectorIdentity.source],
    [connector.entry.sha256, connector.entry.bytes, "planned_overlay"],
  )) {
    throw new Error(
      `Generic fixed-v3 preserved day parent has stale connector identity: ${dayManifestKey} -> ${connectorManifestKey}`,
    );
  }
  const dayChildHash = exactManifestReference(
    day.payload,
    ["connector_manifests", "child_manifests"],
    dayManifestKey,
    connectorManifestKey,
    "manifest_hash",
    day.entry.dependencies.filter((key) =>
      new RegExp(`^${dayPrefix}/connector_id=[1-9]\\d*/manifest\\.json$`).test(key)),
  );
  if (dayChildHash !== connectorManifestHash) {
    throw new Error(`Generic fixed-v3 day parent references stale connector identity: ${connectorManifestKey}`);
  }
  return {
    pollutant_manifest: { object_key: pollutantManifestKey, ...pollutantIdentity },
    connector_parent: {
      object_key: connectorManifestKey,
      pollutant_manifest_key: pollutantManifestKey,
      pollutant_manifest_hash: pollutantManifestHash,
    },
    day_parent: {
      object_key: dayManifestKey,
      connector_manifest_key: connectorManifestKey,
      connector_manifest_hash: connectorManifestHash,
    },
  };
}

function derivePinnedMetadataDependencies(runState, { dayUtc, connectorId, pollutantCode }) {
  if (runState?.dropbox_currentness?.allowed !== true) {
    throw new Error("Generic metadata-only authority requires accepted Dropbox currentness");
  }
  const base = "history/v3/observations";
  const year = dayUtc.slice(0, 4);
  const month = dayUtc.slice(5, 7);
  const keys = [
    `${base}/_manifests/manifest.json`,
    `${base}/_manifests/year=${year}/manifest.json`,
    `${base}/_manifests/year=${year}/month=${month}/manifest.json`,
    `${base}/day_utc=${dayUtc}/manifest.json`,
    `${base}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
    `${base}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`,
  ];
  const root = String(runState?.base_dropbox_root || "");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Generic metadata-only pinned Dropbox root is unavailable");
  }
  if ([9, 10].includes(connectorId)) {
    const manifestKey = keys[5];
    authenticateOfficialRdataPinnedHierarchy(genericV3ValidationRunState(runState), {
      day_utc: dayUtc, connector_id: connectorId, pollutant_code: pollutantCode,
      manifest_key: manifestKey,
      baseline_state: fs.statSync(path.join(root, ...manifestKey.split("/")), { throwIfNoEntry: false })?.isFile()
        ? "partition_present" : "partition_absent",
    });
  }
  const bodies = keys.map((key) => fs.readFileSync(path.join(root, ...key.split("/"))));
  const payloads = bodies.map((body, index) => parsePreservedManifest(body, keys[index]));
  for (let index = 0; index < 5; index += 1) {
    const field = index < 2 ? "content_hash" : "manifest_hash";
    const referenceFields = index < 3 ? ["children"]
      : index === 3 ? ["connector_manifests", "child_manifests"]
        : ["pollutant_manifests", "child_manifests"];
    const referenceHash = exactManifestReference(
      payloads[index], referenceFields, keys[index], keys[index + 1], field,
    );
    if (index >= 3) {
      const parentDir = path.join(root, ...path.posix.dirname(keys[index]).split("/"));
      const physical = [];
      for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          throw new Error(`Generic metadata-only pinned sibling is a symlink: ${keys[index]}`);
        }
        if (!entry.isDirectory()) continue;
        const siblingKey = path.posix.join(path.posix.dirname(keys[index]), entry.name, "manifest.json");
        const siblingPath = path.join(root, ...siblingKey.split("/"));
        if (!fs.lstatSync(siblingPath, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Generic metadata-only pinned sibling manifest is missing: ${siblingKey}`);
        }
        physical.push(siblingKey);
      }
      const references = payloads[index][referenceFields[0]];
      if (!exactArray(physical.sort(bytewise), references.map((ref) => ref.manifest_key).sort(bytewise))) {
        throw new Error(`Generic metadata-only pinned sibling set disagrees: ${keys[index]}`);
      }
      for (const ref of references) {
        const siblingBody = fs.readFileSync(path.join(root, ...ref.manifest_key.split("/")));
        const sibling = parsePreservedManifest(siblingBody, ref.manifest_key);
        if (sibling.manifest_hash !== ref.manifest_hash) {
          throw new Error(`Generic metadata-only pinned sibling identity disagrees: ${ref.manifest_key}`);
        }
      }
    }
    if (!SHA256.test(String(payloads[index + 1][field] || ""))
        || referenceHash !== payloads[index + 1][field]) {
      throw new Error(`Generic metadata-only pinned hierarchy disagrees: ${keys[index]} -> ${keys[index + 1]}`);
    }
  }
  return keys.map((key, index) => ({
    object_key: key,
    sha256: sha256(bodies[index]),
    bytes: bodies[index].byteLength,
    source: "dropbox",
  }));
}

export function canonicalGenericV3SelectedScopeAuthority(runState) {
  genericV3ValidationRunState(runState);
  const authority = runState?.generic_integrity_selected_scope_authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
      || authority.contract_version !== GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
      || authority.history_generation !== "v3"
      || !Array.isArray(authority.selected_scopes)
      || !Array.isArray(authority.metadata_only_scopes)
      || !(authority.selected_scopes.length || authority.metadata_only_scopes.length)
      || !Array.isArray(authority.authorised_pollutant_tombstone_prefixes)) {
    throw new Error("Generic fixed-v3 selected-scope authority is unavailable");
  }
  const seen = new Set();
  const scopes = authority.selected_scopes.map((scope) => {
    const dayUtc = String(scope?.day_utc || "");
    const connectorId = scope?.connector_id;
    const pollutantCode = String(scope?.pollutant_code || "");
    const outcome = String(scope?.outcome || "");
    if (!validDay(dayUtc) || !Number.isSafeInteger(connectorId) || connectorId <= 0
        || !POLLUTANTS.has(pollutantCode) || !OUTCOMES.has(outcome)) {
      throw new Error("Generic fixed-v3 selected scope is invalid");
    }
    const identity = `${dayUtc}|${connectorId}|${pollutantCode}`;
    if (seen.has(identity)) throw new Error("Generic fixed-v3 selected scope is duplicated");
    seen.add(identity);
    const expectedPrefix = `history/v3/observations/day_utc=${dayUtc}`
      + `/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
    if (scope.pollutant_prefix !== expectedPrefix) {
      throw new Error("Generic fixed-v3 selected pollutant prefix is invalid");
    }
    const authorisedPrefix = scope.authorised_tombstone_prefix;
    if (outcome === "source_artifact_unavailable_preserved") {
      if (authorisedPrefix !== null) {
        throw new Error("Generic fixed-v3 preserved scope has deletion authority");
      }
      if ((runState?.tombstone_prefixes || []).some((entry) =>
        entry?.proposed && safeKey(entry.prefix) === expectedPrefix)) {
        throw new Error("Generic fixed-v3 source-unavailable scope has proposed deletion");
      }
    } else if (authorisedPrefix !== expectedPrefix) {
      throw new Error("Generic fixed-v3 selected scope tombstone is invalid");
    }
    if (!Array.isArray(scope.replacement_object_keys)) {
      throw new Error("Generic fixed-v3 replacement object closure is invalid");
    }
    const replacementKeys = [...new Set(scope.replacement_object_keys.map(safeKey))].sort(bytewise);
    if (!exactArray(scope.replacement_object_keys, replacementKeys)
        || replacementKeys.some((key) => !key.startsWith(`${expectedPrefix}/`))) {
      throw new Error("Generic fixed-v3 replacement object closure is not canonical");
    }
    if (outcome === "complete_replacement") {
      if (!replacementKeys.some((key) => key.endsWith(".parquet"))
          || !replacementKeys.includes(`${expectedPrefix}/manifest.json`)) {
        throw new Error("Generic fixed-v3 non-empty replacement closure is incomplete");
      }
    } else if (replacementKeys.length) {
      throw new Error("Generic fixed-v3 empty or preserved scope has replacement children");
    }
    let preservationEvidence = scope.preservation_evidence;
    if (outcome === "source_artifact_unavailable_preserved") {
      const expectedEvidence = deriveGenericPreservedScopeEvidence(runState, {
        dayUtc,
        connectorId,
        pollutantCode,
      });
      if (canonicalTransitionFingerprintJson(preservationEvidence)
          !== canonicalTransitionFingerprintJson(expectedEvidence)) {
        throw new Error("Generic fixed-v3 preserved scope evidence changed");
      }
      preservationEvidence = expectedEvidence;
    } else if (preservationEvidence !== null) {
      throw new Error("Generic fixed-v3 replacement scope has preservation evidence");
    }
    const sourceEvidenceAuthority = scope.source_evidence_authority;
    if ([9, 10].includes(connectorId) && outcome === "source_artifact_unavailable_preserved") {
      if (sourceEvidenceAuthority?.authority_kind !== "authenticated_wholly_source_unavailable_v10"
          || sourceEvidenceAuthority.history_generation !== "v3"
          || sourceEvidenceAuthority.source_adapter !== ({ 9: "waqn", 10: "saqn" })[connectorId]
          || sourceEvidenceAuthority.day_utc !== dayUtc
          || sourceEvidenceAuthority.pollutant_code !== pollutantCode) {
        throw new Error("Generic fixed-v3 preserved v10 source authority is invalid");
      }
      const copy = JSON.parse(JSON.stringify(sourceEvidenceAuthority));
      const claimed = copy.semantic_authority_sha256;
      delete copy.semantic_authority_sha256;
      const auditSha = copy.acquisition_audit_sha256;
      delete copy.acquisition_audit_sha256;
      const audit = copy.acquisition_audit;
      delete copy.acquisition_audit;
      if (claimed !== sha256(Buffer.from(canonicalTransitionFingerprintJson(copy), "utf8"))
          || audit?.audit_contract_version !== 2
          || audit?.semantic_authority_sha256 !== claimed
          || auditSha !== sha256(Buffer.from(canonicalTransitionFingerprintJson(audit), "utf8"))) {
        throw new Error("Generic fixed-v3 preserved v10 source authority hash changed");
      }
    } else if (sourceEvidenceAuthority !== null) {
      throw new Error("Generic fixed-v3 unexpected preserved source authority");
    }
    return {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      pollutant_prefix: expectedPrefix,
      outcome,
      authorised_tombstone_prefix: authorisedPrefix,
      replacement_object_keys: replacementKeys,
      preservation_evidence: preservationEvidence,
      source_evidence_authority: sourceEvidenceAuthority,
    };
  }).sort((left, right) => bytewise(left.day_utc, right.day_utc)
    || left.connector_id - right.connector_id
    || bytewise(left.pollutant_code, right.pollutant_code));
  if (canonicalTransitionFingerprintJson(authority.selected_scopes)
      !== canonicalTransitionFingerprintJson(scopes)) {
    throw new Error("Generic fixed-v3 selected scopes are not canonical");
  }
  const authorisedPrefixes = [...new Set(
    authority.authorised_pollutant_tombstone_prefixes.map(safeKey),
  )].sort(bytewise);
  const expectedPrefixes = [...new Set(scopes
    .map((scope) => scope.authorised_tombstone_prefix)
    .filter((prefix) => prefix !== null))].sort(bytewise);
  if (!exactArray(authority.authorised_pollutant_tombstone_prefixes, authorisedPrefixes)
      || !exactArray(authorisedPrefixes, expectedPrefixes)) {
    throw new Error("Generic fixed-v3 authorised tombstone set is not exact");
  }
  const proposed = (runState?.tombstone_prefixes || [])
    .filter((entry) => entry?.proposed)
    .map((entry) => safeKey(entry.prefix)).sort(bytewise);
  if (!exactArray(proposed, authorisedPrefixes)) {
    throw new Error("Generic fixed-v3 proposed tombstones exceed selected authority");
  }
  const dataIdentities = new Set(scopes.map((scope) =>
    `${scope.day_utc}|${scope.connector_id}|${scope.pollutant_code}`));
  const metadataSeen = new Set();
  const objectKeys = Object.keys(runState?.objects || {});
  const metadataScopes = authority.metadata_only_scopes.map((raw) => {
    const dayUtc = String(raw?.day_utc || "");
    const connectorId = raw?.connector_id;
    const pollutantCode = String(raw?.pollutant_code || "");
    const identity = `${dayUtc}|${connectorId}|${pollutantCode}`;
    if (!validDay(dayUtc) || !Number.isSafeInteger(connectorId) || connectorId <= 0
        || !POLLUTANTS.has(pollutantCode) || dataIdentities.has(identity)
        || metadataSeen.has(identity)) {
      throw new Error("Generic metadata-only scope identity is invalid");
    }
    metadataSeen.add(identity);
    const prefix = `history/_index_v3/observations_timeseries/day_utc=${dayUtc}`
      + `/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
    const alignedPrefix = prefix.replace(
      "observations_timeseries/day_utc=", "observations_timeseries/_aligned/day_utc=",
    );
    const derivedKeys = objectKeys.filter((key) => key.startsWith(`${prefix}/`)
      || key.startsWith(`${alignedPrefix}/`)).sort(bytewise);
    const dependencies = derivePinnedMetadataDependencies(runState, {
      dayUtc, connectorId, pollutantCode,
    });
    if (raw.derived_index_prefix !== prefix
        || !derivedKeys.includes(`${prefix}/manifest.json`)
        || !exactArray(raw.derived_object_keys, derivedKeys)
        || !exactArray(raw.observation_deletion_prefixes, [])
        || canonicalTransitionFingerprintJson(raw.canonical_dependencies)
          !== canonicalTransitionFingerprintJson(dependencies)) {
      throw new Error("Generic metadata-only scope closure changed");
    }
    return {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      derived_index_prefix: prefix,
      canonical_dependencies: dependencies,
      derived_object_keys: derivedKeys,
      observation_deletion_prefixes: [],
    };
  }).sort((left, right) => bytewise(left.day_utc, right.day_utc)
    || left.connector_id - right.connector_id
    || bytewise(left.pollutant_code, right.pollutant_code));
  if (canonicalTransitionFingerprintJson(authority.metadata_only_scopes)
      !== canonicalTransitionFingerprintJson(metadataScopes)) {
    throw new Error("Generic metadata-only scopes are not canonical");
  }
  const latestKey = "history/_index_v3/observations_timeseries_latest.json";
  const derivedWriteKeys = [...new Set([
    ...metadataScopes.flatMap((scope) => scope.derived_object_keys),
    ...(metadataScopes.length && objectKeys.includes(latestKey) ? [latestKey] : []),
  ])].sort(bytewise);
  if (!exactArray(authority.metadata_only_derived_write_object_keys, derivedWriteKeys)) {
    throw new Error("Generic metadata-only derived write set changed");
  }
  if (metadataScopes.length && !scopes.length) {
    const allDerivedKeys = objectKeys.filter((key) =>
      key.startsWith("history/_index_v3/observations_timeseries/")
      || key === latestKey).sort(bytewise);
    if (!exactArray(allDerivedKeys, derivedWriteKeys)
        || !exactArray([...objectKeys].sort(bytewise), derivedWriteKeys)) {
      throw new Error("Generic metadata-only derived closure is not exact");
    }
  }
  const forceTargets = runState?.explicit_official_force_partitions || [];
  if (!Array.isArray(forceTargets) || forceTargets.some((target) =>
    target?.target_authority !== "explicit_manual_force_replacement"
    || ![9, 10].includes(target?.connector_id))) {
    throw new Error("Generic explicit force target is invalid");
  }
  const expectedTargets = [...new Set(forceTargets.map((target) =>
    `${target?.day_utc}|${target?.connector_id}|${target?.pollutant_code}`))]
    .sort(bytewise).map((value) => {
      const [dayUtc, connectorId, pollutantCode] = value.split("|");
      return { day_utc: dayUtc, connector_id: Number(connectorId), pollutant_code: pollutantCode };
    });
  if (canonicalTransitionFingerprintJson(authority.explicit_force_targets)
        !== canonicalTransitionFingerprintJson(expectedTargets)
      || Boolean(expectedTargets.length) !== Boolean(runState?.explicit_official_force_replacement)
      || (expectedTargets.length && !exactArray(
        expectedTargets.map((target) => `${target.day_utc}|${target.connector_id}|${target.pollutant_code}`),
        [...dataIdentities].sort(bytewise),
      ))) {
    throw new Error("Generic explicit force authority changed");
  }
  const forcedParquetKeys = objectKeys.filter((key) => key.endsWith(".parquet")
    && expectedTargets.some((target) => key.startsWith(
      `history/v3/observations/day_utc=${target.day_utc}`
      + `/connector_id=${target.connector_id}/pollutant_code=${target.pollutant_code}/`,
    ))).sort(bytewise);
  if (!exactArray(authority.forced_republication_parquet_keys, forcedParquetKeys)) {
    throw new Error("Generic forced Parquet write set changed");
  }
  return {
    contract_version: GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT,
    history_generation: "v3",
    selected_scopes: scopes,
    metadata_only_scopes: metadataScopes,
    metadata_only_derived_write_object_keys: derivedWriteKeys,
    explicit_force_targets: expectedTargets,
    forced_republication_parquet_keys: forcedParquetKeys,
    authorised_pollutant_tombstone_prefixes: authorisedPrefixes,
  };
}

export function genericV3TransitionStateFingerprintPayload(runState) {
  if (runState?.execution_path !== "generic_integrity") {
    throw new Error("Generic fixed-v3 fingerprint requires execution_path=generic_integrity");
  }
  return {
    contract_version: GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    execution_path: "generic_integrity",
    history_generation: "v3",
    official_rdata_publication_authority:
      runState?.official_rdata_source_adapter
        ? requireGenericV3OfficialRdataAuthority(runState) : null,
    generic_selected_scope_authority: canonicalGenericV3SelectedScopeAuthority(runState),
    ...coordinatorTransitionStateCommonFingerprintPayload(runState),
  };
}

export function computeGenericV3TransitionStateFingerprint(runState) {
  return sha256(Buffer.from(
    canonicalTransitionFingerprintJson(genericV3TransitionStateFingerprintPayload(runState)),
    "utf8",
  ));
}

export function requireGenericV3CoordinatorFreeze(runState, env = process.env) {
  if (runState?.execution_path !== "generic_integrity"
      || runState?.dedicated_sos_historical_replacement !== false
      || !["TEST", "LIVE"].includes(runState?.environment)) {
    throw new Error("Generic fixed-v3 execution or environment authority is invalid");
  }
  if (runState.apply !== undefined && runState.apply !== null) {
    throw new Error(
      "Generic fixed-v3 run already has APPLY state; recovery requires a fresh Integrity run",
    );
  }
  const configuredEnvironment = String(
    env.UK_AQ_ENV_NAME || env.ENVIRONMENT || "",
  ).trim();
  if (!["TEST", "LIVE"].includes(configuredEnvironment)
      || configuredEnvironment !== runState.environment) {
    throw new Error("Generic fixed-v3 configured environment disagrees with run state");
  }
  const ingestion = runState?.proposal_ingestion;
  if (ingestion?.status !== "complete"
      || ingestion?.transport_mode !== "file_backed_compact_proposal"
      || ingestion?.node_apply_launch_permitted !== false
      || !Number.isSafeInteger(Number(ingestion?.completed_object_count))
      || Number(ingestion.completed_object_count) !== Number(ingestion.total_object_count)) {
    throw new Error("Generic fixed-v3 proposal ingestion checkpoint is incomplete");
  }
  const provenance = runState?.final_staged_write_set_provenance;
  if (provenance?.status !== "finalised"
      || Number(provenance.final_staged_object_count)
        !== Object.keys(runState?.objects || {}).length) {
    throw new Error("Generic fixed-v3 final staged write-set provenance is incomplete");
  }
  const transition = runState?.proposal_transition_validation;
  if (transition?.status !== "succeeded" || transition?.node_apply_launch_permitted !== true
      || transition?.state_fingerprint_contract_version
        !== GENERIC_INTEGRITY_V3_TRANSITION_STATE_FINGERPRINT_CONTRACT
      || !SHA256.test(String(transition?.state_fingerprint_sha256 || ""))) {
    throw new Error("Generic fixed-v3 coordinator transition validation is not frozen");
  }
  const actual = computeGenericV3TransitionStateFingerprint(runState);
  if (actual !== transition.state_fingerprint_sha256) {
    throw new Error("Generic fixed-v3 coordinator transition evidence is stale or changed");
  }
  return { generic_fixed_v3: true, authority: canonicalGenericV3SelectedScopeAuthority(runState) };
}

export function validateLocalGenericV3Proposal(runState, env = process.env) {
  requireGenericV3CoordinatorFreeze(runState, env);
  const authority = canonicalGenericV3SelectedScopeAuthority(runState);
  const proposal = validateLocalProposal(runState, { generation: "v3" });
  const byPrefix = new Map(authority.selected_scopes.map((scope) => [
    `history/v3/observations/day_utc=${scope.day_utc}`
      + `/connector_id=${scope.connector_id}/pollutant_code=${scope.pollutant_code}`,
    scope,
  ]));
  for (const { prefix, entry } of proposal.prefixes) {
    const scope = byPrefix.get(prefix);
    if (!scope || !POLLUTANT_PREFIX.test(prefix)
        || entry?.authority_outcome !== scope.outcome
        || entry?.authority_scope?.day_utc !== scope.day_utc
        || entry?.authority_scope?.connector_id !== scope.connector_id
        || entry?.authority_scope?.pollutant_code !== scope.pollutant_code) {
      throw new Error(`Generic fixed-v3 tombstone justification is invalid: ${prefix}`);
    }
  }
  const objectKeys = new Set(proposal.objects.map((object) => object.key));
  for (const [prefix, scope] of byPrefix) {
    const actualKeys = [...objectKeys].filter((key) => key.startsWith(`${prefix}/`)).sort(bytewise);
    if (!exactArray(actualKeys, scope.replacement_object_keys)) {
      throw new Error(`Generic fixed-v3 selected replacement closure changed: ${prefix}`);
    }
    if (scope.outcome === "source_artifact_unavailable_preserved") {
      const evidence = deriveGenericPreservedScopeEvidence(runState, {
        dayUtc: scope.day_utc,
        connectorId: scope.connector_id,
        pollutantCode: scope.pollutant_code,
      });
      if (canonicalTransitionFingerprintJson(evidence)
          !== canonicalTransitionFingerprintJson(scope.preservation_evidence)) {
        throw new Error(`Generic fixed-v3 preserved scope evidence changed: ${prefix}`);
      }
    }
  }
  return proposal;
}

export async function validateFinalGenericV3ProposalGraph({ runState, proposal }) {
  const authority = canonicalGenericV3SelectedScopeAuthority(runState);
  if (["waqn", "saqn"].includes(runState.official_rdata_source_adapter)) {
    const seen = new Set();
    for (const scope of authority.selected_scopes) {
      if (scope.outcome === "source_artifact_unavailable_preserved") {
        validateOfficialRdataV10PreservedOnlyAuthority(scope.source_evidence_authority);
        continue;
      }
      const key = `${scope.day_utc}|${scope.connector_id}`;
      if (seen.has(key)) continue;
      const source = loadImmutableSourcePartition({
        runState, dayUtc: scope.day_utc, connectorId: scope.connector_id,
        pollutantCode: scope.pollutant_code,
      });
      await validateOfficialRdataPreservationDependencies({
        runState: genericV3ValidationRunState(runState, source), source,
      });
      seen.add(key);
    }
  }
  return await validateFinalProposalGraph({
    runState,
    proposal,
    genericSelectedScopeAuthority: authority,
  });
}
