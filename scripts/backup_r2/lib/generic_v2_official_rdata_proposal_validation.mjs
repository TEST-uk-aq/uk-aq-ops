/** Generic fixed-v2 selected-scope proposal validation boundary. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import {
  OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT,
  requireOfficialRdataTimestampAuthority as requireAcceptedOfficialRdataTimestampAuthority,
} from "./official_rdata_timestamp_authority_validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLLUTANTS = new Set(["pm25", "pm10", "no2", "o3"]);
const OUTCOMES = new Set([
  "complete_replacement",
  "partial_source_unavailable_preserved_replacement",
  "authoritative_no_data_replacement",
  "source_artifact_unavailable_preserved",
]);
const POLLUTANT_PREFIX = /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)\/pollutant_code=([a-z0-9_]+)$/;
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

export const GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT =
  "uk_aq_generic_integrity_v2_transition_state_fingerprint_v3";
export const GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT =
  "uk_aq_generic_integrity_v2_selected_scope_authority_v1";
export const GENERIC_V2_OPERATIONAL_CONTEXT_CONTRACT =
  "uk_aq_generic_v2_official_rdata_operational_context_v1";
export const RETAINED_V2_MAINTENANCE_CONTEXT_CONTRACT =
  "uk_aq_retained_v2_official_rdata_maintenance_v1";
export const SERVING_V2_LIVE_CONTEXT_CONTRACT =
  "uk_aq_serving_v2_official_rdata_integrity_v1";
export { OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_CONTRACT };

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
    throw new Error(`Unsafe generic fixed-v2 key: ${String(raw)}`);
  }
  return key;
}

function authoritativeNormalConfiguration(env) {
  const envPath = String(env.UK_AQ_BACKFILL_ENV_FILE || "").trim();
  let body;
  try {
    body = fs.readFileSync(envPath);
  } catch {
    throw new Error("Generic fixed-v2 authoritative environment configuration is unavailable");
  }
  const values = {};
  for (const rawLine of body.toString("utf8").split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    values[match[1]] = value;
  }
  const environment = String(
    values.UK_AQ_ENV_NAME || values.UKAQ_ENV_NAME || values.ENVIRONMENT || "",
  ).trim();
  const servingGeneration = String(values.UK_AQ_R2_HISTORY_VERSION || "").trim();
  const indexGeneration = String(
    values.UK_AQ_R2_HISTORY_INDEX_VERSION || servingGeneration,
  ).trim();
  const bucket = String(values.CFLARE_R2_BUCKET || values.R2_BUCKET || "").trim();
  if (!envPath || !["TEST", "LIVE"].includes(environment)
      || !["v2", "v3"].includes(servingGeneration)
      || indexGeneration !== servingGeneration || !bucket) {
    throw new Error("Generic fixed-v2 authoritative environment configuration is contradictory");
  }
  const identity = {
    bucket,
    environment,
    index_generation: indexGeneration,
    serving_generation: servingGeneration,
  };
  if (String(env.UK_AQ_R2_HISTORY_VERSION || "").trim() !== "v2"
      || String(env.UK_AQ_R2_HISTORY_INDEX_VERSION || "v2").trim() !== "v2") {
    throw new Error("Generic fixed-v2 selected operation generation is not v2");
  }
  return {
    environment,
    serving_generation: servingGeneration,
    index_generation: indexGeneration,
    bucket,
    sha256: sha256(Buffer.from(canonicalTransitionFingerprintJson(identity), "utf8")),
  };
}

function authenticatedImplementationRevision(env) {
  const repoRoot = String(env.UK_AQ_OPS_REPO_ROOT || process.cwd()).trim();
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    if (!GIT_SHA.test(revision)) throw new Error("invalid revision");
    return revision;
  } catch {
    throw new Error("Generic fixed-v2 implementation revision cannot be authenticated");
  }
}

function officialRdataSemanticEvidenceSha256(evidence) {
  const allowed = new Set([
    ...OFFICIAL_RDATA_V8_FIELDS,
    "semantic_evidence_sha256", "acquisition_audit", "acquisition_audit_sha256",
  ]);
  if (OFFICIAL_RDATA_V8_FIELDS.some((field) => !Object.hasOwn(evidence || {}, field))
      || Object.keys(evidence || {}).some((field) => !allowed.has(field))) {
    throw new Error("Generic fixed-v2 official semantic evidence shape is invalid");
  }
  return sha256(Buffer.from(canonicalTransitionFingerprintJson(
    Object.fromEntries(OFFICIAL_RDATA_V8_FIELDS.map((field) => [field, evidence[field]])),
  ), "utf8"));
}

function parsePreservedManifest(body, objectKey) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new Error(`Generic fixed-v2 preserved manifest JSON is invalid: ${objectKey}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Generic fixed-v2 preserved manifest JSON is invalid: ${objectKey}`);
  }
  return payload;
}

function exactManifestReference(payload, fields, parentKey, childKey) {
  const references = new Map();
  for (const field of fields) {
    const rawReferences = payload[field] || [];
    if (!Array.isArray(rawReferences)) {
      throw new Error(`Generic fixed-v2 preserved parent references are invalid: ${parentKey}`);
    }
    for (const reference of rawReferences) {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
        throw new Error(`Generic fixed-v2 preserved parent reference is invalid: ${parentKey}`);
      }
      const manifestKey = String(reference.manifest_key || "");
      const manifestHash = String(reference.manifest_hash || "");
      if (!manifestKey) continue;
      if (references.has(manifestKey) && references.get(manifestKey) !== manifestHash) {
        throw new Error(
          `Generic fixed-v2 preserved parent has contradictory child identity: ${parentKey} -> ${manifestKey}`,
        );
      }
      references.set(manifestKey, manifestHash);
    }
  }
  const manifestHash = references.get(childKey);
  if (!SHA256.test(String(manifestHash || ""))) {
    throw new Error(
      `Generic fixed-v2 preserved parent lacks exact child reference: ${parentKey} -> ${childKey}`,
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
    throw new Error(`Generic fixed-v2 dependency identity is invalid: ${parentKey} -> ${childKey}`);
  }
  return identity;
}

function readStagedPreservedManifest(runState, objectKey) {
  const entry = runState?.objects?.[objectKey];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Generic fixed-v2 preserved parent is not staged: ${objectKey}`);
  }
  let body;
  try {
    body = fs.readFileSync(String(entry.local_path || ""));
  } catch {
    throw new Error(`Generic fixed-v2 preserved parent body is unavailable: ${objectKey}`);
  }
  if (body.byteLength !== entry.bytes || sha256(body) !== String(entry.sha256 || "")) {
    throw new Error(`Generic fixed-v2 preserved parent identity changed: ${objectKey}`);
  }
  return { entry, body, payload: parsePreservedManifest(body, objectKey) };
}

function deriveGenericPreservedScopeEvidence(runState, { dayUtc, connectorId, pollutantCode }) {
  const dayPrefix = `history/v2/observations/day_utc=${dayUtc}`;
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
      `Generic fixed-v2 preserved connector lacks exact pollutant dependency: ${connectorManifestKey} -> ${pollutantManifestKey}`,
    );
  }
  const pollutantIdentity = normalizedDependencyIdentity(
    connector.entry.dependency_identities?.[pollutantManifestKey],
    connectorManifestKey,
    pollutantManifestKey,
  );
  if (!["dropbox", "overlay"].includes(pollutantIdentity.source)) {
    throw new Error(
      `Generic fixed-v2 preserved pollutant manifest is not externally pinned: ${pollutantManifestKey}`,
    );
  }
  const externalRoot = pollutantIdentity.source === "dropbox"
    ? runState.base_dropbox_root : runState.overlay_root;
  if (!externalRoot || !fs.statSync(String(externalRoot), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Generic fixed-v2 preserved external root is unavailable: ${pollutantIdentity.source}`,
    );
  }
  let pollutantBody;
  try {
    pollutantBody = fs.readFileSync(path.join(String(externalRoot || ""), ...pollutantManifestKey.split("/")));
  } catch {
    throw new Error(`Generic fixed-v2 preserved pollutant manifest is unavailable: ${pollutantManifestKey}`);
  }
  if (pollutantBody.byteLength !== pollutantIdentity.bytes
      || sha256(pollutantBody) !== pollutantIdentity.sha256) {
    throw new Error(`Generic fixed-v2 preserved pollutant manifest identity changed: ${pollutantManifestKey}`);
  }
  const pollutantPayload = parsePreservedManifest(pollutantBody, pollutantManifestKey);
  const pollutantManifestHash = String(pollutantPayload.manifest_hash || "");
  if (!SHA256.test(pollutantManifestHash)) {
    throw new Error(`Generic fixed-v2 preserved pollutant manifest hash is invalid: ${pollutantManifestKey}`);
  }
  const connectorChildHash = exactManifestReference(
    connector.payload,
    ["pollutant_manifests", "child_manifests"],
    connectorManifestKey,
    pollutantManifestKey,
  );
  if (connectorChildHash !== pollutantManifestHash) {
    throw new Error(`Generic fixed-v2 connector references stale pollutant identity: ${pollutantManifestKey}`);
  }
  const connectorManifestHash = String(connector.payload.manifest_hash || "");
  if (!SHA256.test(connectorManifestHash)) {
    throw new Error(`Generic fixed-v2 preserved connector manifest hash is invalid: ${connectorManifestKey}`);
  }
  if (!Array.isArray(day.entry.dependencies)
      || !day.entry.dependencies.includes(connectorManifestKey)) {
    throw new Error(
      `Generic fixed-v2 preserved day parent lacks staged connector: ${dayManifestKey} -> ${connectorManifestKey}`,
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
      `Generic fixed-v2 preserved day parent has stale connector identity: ${dayManifestKey} -> ${connectorManifestKey}`,
    );
  }
  const dayChildHash = exactManifestReference(
    day.payload,
    ["connector_manifests", "child_manifests"],
    dayManifestKey,
    connectorManifestKey,
  );
  if (dayChildHash !== connectorManifestHash) {
    throw new Error(`Generic fixed-v2 day parent references stale connector identity: ${connectorManifestKey}`);
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
  const base = "history/v2/observations";
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
  const bodies = keys.map((key) => fs.readFileSync(path.join(root, ...key.split("/"))));
  const payloads = bodies.map((body, index) => parsePreservedManifest(body, keys[index]));
  for (let index = 0; index < 5; index += 1) {
    const field = index < 2 ? "content_hash" : "manifest_hash";
    const referenceFields = index < 3 ? ["children"]
      : index === 3 ? ["connector_manifests", "child_manifests"]
        : ["pollutant_manifests", "child_manifests"];
    const references = referenceFields.flatMap((name) => payloads[index][name] || [])
      .filter((entry) => entry?.manifest_key === keys[index + 1]);
    if (references.length !== 1
        || !SHA256.test(String(payloads[index + 1][field] || ""))
        || references[0][field] !== payloads[index + 1][field]) {
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

function canonicalBindingVerification(raw) {
  const provider = raw?.provider || {};
  const providerProjection = {
    mode: String(provider.mode || ""),
    observation_generation: String(provider.observation_generation || "v2"),
    authenticated_generation_complete:
      provider.authenticated_generation_complete === true,
    pack_root_relative_path: provider.pack_root_relative_path ?? null,
    pack_root_sha256: provider.pack_root_sha256 ?? null,
    source_root_hash: provider.source_root_hash ?? null,
    checkpoint_source_root_hash: provider.checkpoint_source_root_hash ?? null,
    ranges_verified: provider.ranges_verified ?? null,
    total_pack_members_verified: provider.total_pack_members_verified ?? null,
    authenticated_members_returned: provider.authenticated_members_returned ?? null,
  };
  return {
    status: String(raw?.status || ""),
    source_adapter: String(raw?.source_adapter || ""),
    connector_id: raw?.connector_id,
    pollutant_codes: [...(raw?.pollutant_codes || [])].sort(bytewise),
    required_timeseries_ids: [...(raw?.required_timeseries_ids || [])]
      .map(Number).sort((left, right) => left - right),
    required_binding_count: raw?.required_binding_count,
    gap_count: raw?.gap_count,
    provider: providerProjection,
  };
}

function canonicalScopeSourceAuthority(raw, {
  dayUtc, connectorId, pollutantCode, outcome,
}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.contract_version
        !== "uk_aq_generic_v2_official_rdata_scope_source_authority_v1"
      || raw.history_generation !== "v2"
      || raw.day_utc !== dayUtc
      || raw.connector_id !== connectorId
      || raw.pollutant_code !== pollutantCode
      || !["waqn", "saqn"].includes(raw.source_adapter)) {
    throw new Error("Generic fixed-v2 scope source authority changed");
  }
  const authority = JSON.parse(JSON.stringify(raw));
  if (authority.authority_kind === "persisted_official_rdata_v8_semantic_evidence") {
    const hashes = [
      "semantic_evidence_sha256", "source_evidence_input_sha256",
      "acquisition_audit_sha256", "source_file_identities_sha256",
      "source_artifact_availability_sha256",
      "authoritative_station_timeseries_mapping_sha256",
      "observed_property_mapping_sha256", "preserved_baseline_dependency_sha256",
      "canonical_rows_sha256",
    ];
    const required = new Set(authority.files_required || []);
    const read = new Set(authority.files_read || []);
    const absent = new Set(authority.files_authoritatively_absent || []);
    const selectedCount = authority.selected_final_target_row_count;
    const selectedHasUnavailableScope = (authority.source_unavailable_scopes || [])
      .some((scope) => scope?.pollutant_code === pollutantCode);
    if (hashes.some((key) => !SHA256.test(String(authority[key] || "")))
        || !Number.isSafeInteger(authority.evidence_id) || authority.evidence_id <= 0
        || !Number.isSafeInteger(authority.acquisition_audit_id)
        || authority.acquisition_audit_id <= 0
        || [...required].some((key) => !read.has(key) && !absent.has(key))
        || [...read].some((key) => absent.has(key) || !required.has(key))
        || [...absent].some((key) => !required.has(key))
        || authority.timestamp_mapping
          !== "rdata_posixct_gmt_instant_to_observed_at_utc"
        || !Number.isSafeInteger(authority.final_target_row_count)
        || authority.final_target_row_count < 0
        || !Number.isSafeInteger(selectedCount) || selectedCount < 0
        || authority.selected_final_target_authoritatively_empty !== (selectedCount === 0)
        || (outcome === "authoritative_no_data_replacement") !== (selectedCount === 0)
        || (outcome === "partial_source_unavailable_preserved_replacement")
          !== (selectedHasUnavailableScope && selectedCount > 0)
        || (outcome === "complete_replacement" && selectedHasUnavailableScope)) {
      throw new Error("Generic fixed-v2 persisted source authority is invalid");
    }
  } else if (authority.authority_kind === "authenticated_wholly_source_unavailable") {
    const semanticSha = String(authority.semantic_authority_sha256 || "");
    delete authority.semantic_authority_sha256;
    if (outcome !== "source_artifact_unavailable_preserved"
        || !SHA256.test(semanticSha)
        || !exactArray(authority.files_read, [])
        || !Array.isArray(authority.files_required) || !authority.files_required.length
        || !exactArray(authority.files_required, authority.files_authoritatively_absent)
        || !Array.isArray(authority.source_unavailable_timeseries_ids)
        || !authority.source_unavailable_timeseries_ids.length
        || !Array.isArray(authority.source_unavailable_scopes)
        || !authority.source_unavailable_scopes.length
        || semanticSha !== sha256(Buffer.from(
          canonicalTransitionFingerprintJson(authority), "utf8",
        ))) {
      throw new Error("Generic fixed-v2 unavailable source authority is invalid");
    }
    authority.semantic_authority_sha256 = semanticSha;
  } else {
    throw new Error("Generic fixed-v2 scope source authority kind is invalid");
  }
  return authority;
}

function validatePersistedScopeSourceEvidence(runState, scope) {
  const authority = scope.source_evidence_authority;
  if (authority.authority_kind !== "persisted_official_rdata_v8_semantic_evidence") return;
  const source = loadImmutableSourcePartition({
    runState,
    dayUtc: scope.day_utc,
    connectorId: scope.connector_id,
    pollutantCode: scope.pollutant_code,
  });
  const evidence = source.evidence;
  const semanticSha = officialRdataSemanticEvidenceSha256(evidence);
  const projection = {
    semantic_evidence_sha256: semanticSha,
    source_evidence_input_sha256: evidence.source_evidence_input_sha256,
    source_file_identities_sha256: evidence.source_file_identities_sha256,
    source_file_identities: evidence.source_file_identities,
    files_required: evidence.files_required,
    files_read: evidence.files_read,
    files_authoritatively_absent: evidence.files_authoritatively_absent,
    source_available_timeseries_ids: evidence.source_available_timeseries_ids,
    source_unavailable_timeseries_ids: evidence.source_unavailable_timeseries_ids,
    source_unavailable_scopes: evidence.source_unavailable_scopes,
    source_artifact_availability_sha256: evidence.source_artifact_availability_sha256,
    authoritative_station_timeseries_mapping_sha256:
      evidence.authoritative_station_timeseries_mapping_sha256,
    observed_property_mapping_sha256: evidence.observed_property_mapping_sha256,
    preserved_baseline_dependency_sha256: evidence.preserved_baseline_dependency_sha256,
    preserved_baseline_identity: evidence.preserved_baseline_identity,
    canonical_rows_sha256: evidence.canonical_rows_sha256,
    canonical_rows_bytes: evidence.canonical_rows_bytes,
    final_target_row_count: evidence.final_target_row_count,
    final_target_timeseries_row_counts: evidence.final_target_timeseries_row_counts,
    final_target_pollutant_counts: evidence.final_target_pollutant_counts,
    final_target_observation_content_hashes: evidence.final_target_observation_content_hashes,
    timestamp_mapping: evidence.timestamp_mapping,
  };
  const expected = Object.fromEntries(Object.keys(projection).map((key) => [key, authority[key]]));
  if (semanticSha !== evidence.semantic_evidence_sha256
      || semanticSha !== authority.semantic_evidence_sha256
      || authority.acquisition_audit_sha256 !== evidence.acquisition_audit_sha256
      || canonicalTransitionFingerprintJson(projection)
        !== canonicalTransitionFingerprintJson(expected)) {
    throw new Error("Generic fixed-v2 persisted source evidence changed before APPLY");
  }
}

export function canonicalGenericV2SelectedScopeAuthority(runState) {
  const authority = runState?.generic_integrity_selected_scope_authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
      || authority.contract_version !== GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT
      || authority.history_generation !== "v2"
      || !Array.isArray(authority.selected_scopes)
      || !Array.isArray(authority.metadata_only_scopes)
      || !(authority.selected_scopes.length || authority.metadata_only_scopes.length)
      || !Array.isArray(authority.authorised_pollutant_tombstone_prefixes)) {
    throw new Error("Generic fixed-v2 selected-scope authority is unavailable");
  }
  const seen = new Set();
  const scopes = authority.selected_scopes.map((scope) => {
    const dayUtc = String(scope?.day_utc || "");
    const connectorId = scope?.connector_id;
    const pollutantCode = String(scope?.pollutant_code || "");
    const outcome = String(scope?.outcome || "");
    if (!validDay(dayUtc) || !Number.isSafeInteger(connectorId) || connectorId <= 0
        || !POLLUTANTS.has(pollutantCode) || !OUTCOMES.has(outcome)) {
      throw new Error("Generic fixed-v2 selected scope is invalid");
    }
    const identity = `${dayUtc}|${connectorId}|${pollutantCode}`;
    if (seen.has(identity)) throw new Error("Generic fixed-v2 selected scope is duplicated");
    seen.add(identity);
    const expectedPrefix = `history/v2/observations/day_utc=${dayUtc}`
      + `/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
    if (scope.pollutant_prefix !== expectedPrefix) {
      throw new Error("Generic fixed-v2 selected pollutant prefix is invalid");
    }
    const authorisedPrefix = scope.authorised_tombstone_prefix;
    if (outcome === "source_artifact_unavailable_preserved") {
      if (authorisedPrefix !== null) {
        throw new Error("Generic fixed-v2 preserved scope has deletion authority");
      }
      if ((runState?.tombstone_prefixes || []).some((entry) =>
        entry?.proposed && safeKey(entry.prefix) === expectedPrefix)) {
        throw new Error("Generic fixed-v2 source-unavailable scope has proposed deletion");
      }
    } else if (authorisedPrefix !== expectedPrefix) {
      throw new Error("Generic fixed-v2 selected scope tombstone is invalid");
    }
    if (!Array.isArray(scope.replacement_object_keys)) {
      throw new Error("Generic fixed-v2 replacement object closure is invalid");
    }
    const replacementKeys = [...new Set(scope.replacement_object_keys.map(safeKey))].sort(bytewise);
    if (!exactArray(scope.replacement_object_keys, replacementKeys)
        || replacementKeys.some((key) => !key.startsWith(`${expectedPrefix}/`))) {
      throw new Error("Generic fixed-v2 replacement object closure is not canonical");
    }
    if ([
      "complete_replacement",
      "partial_source_unavailable_preserved_replacement",
    ].includes(outcome)) {
      if (!replacementKeys.some((key) => key.endsWith(".parquet"))
          || !replacementKeys.includes(`${expectedPrefix}/manifest.json`)) {
        throw new Error("Generic fixed-v2 non-empty replacement closure is incomplete");
      }
    } else if (replacementKeys.length) {
      throw new Error("Generic fixed-v2 empty or preserved scope has replacement children");
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
        throw new Error("Generic fixed-v2 preserved scope evidence changed");
      }
      preservationEvidence = expectedEvidence;
    } else if (preservationEvidence !== null) {
      throw new Error("Generic fixed-v2 replacement scope has preservation evidence");
    }
    const sourceEvidenceAuthority = canonicalScopeSourceAuthority(
      scope.source_evidence_authority,
      { dayUtc, connectorId, pollutantCode, outcome },
    );
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
    throw new Error("Generic fixed-v2 selected scopes are not canonical");
  }
  const authorisedPrefixes = [...new Set(
    authority.authorised_pollutant_tombstone_prefixes.map(safeKey),
  )].sort(bytewise);
  const expectedPrefixes = [...new Set(scopes
    .map((scope) => scope.authorised_tombstone_prefix)
    .filter((prefix) => prefix !== null))].sort(bytewise);
  if (!exactArray(authority.authorised_pollutant_tombstone_prefixes, authorisedPrefixes)
      || !exactArray(authorisedPrefixes, expectedPrefixes)) {
    throw new Error("Generic fixed-v2 authorised tombstone set is not exact");
  }
  const proposed = (runState?.tombstone_prefixes || [])
    .filter((entry) => entry?.proposed)
    .map((entry) => safeKey(entry.prefix)).sort(bytewise);
  if (!exactArray(proposed, authorisedPrefixes)) {
    throw new Error("Generic fixed-v2 proposed tombstones exceed selected authority");
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
    const prefix = `history/_index_v2/observations_timeseries/day_utc=${dayUtc}`
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
  const latestKey = "history/_index_v2/observations_timeseries_latest.json";
  const derivedWriteKeys = [...new Set([
    ...metadataScopes.flatMap((scope) => scope.derived_object_keys),
    ...(metadataScopes.length && objectKeys.includes(latestKey) ? [latestKey] : []),
  ])].sort(bytewise);
  if (!exactArray(authority.metadata_only_derived_write_object_keys, derivedWriteKeys)) {
    throw new Error("Generic metadata-only derived write set changed");
  }
  if (metadataScopes.length && !scopes.length) {
    const allDerivedKeys = objectKeys.filter((key) =>
      key.startsWith("history/_index_v2/observations_timeseries/")
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
      `history/v2/observations/day_utc=${target.day_utc}`
      + `/connector_id=${target.connector_id}/pollutant_code=${target.pollutant_code}/`,
    ))).sort(bytewise);
  if (!exactArray(authority.forced_republication_parquet_keys, forcedParquetKeys)) {
    throw new Error("Generic forced Parquet write set changed");
  }
  return {
    contract_version: GENERIC_INTEGRITY_V2_SELECTED_SCOPE_AUTHORITY_CONTRACT,
    history_generation: "v2",
    selected_scopes: scopes,
    metadata_only_scopes: metadataScopes,
    metadata_only_derived_write_object_keys: derivedWriteKeys,
    explicit_force_targets: expectedTargets,
    forced_republication_parquet_keys: forcedParquetKeys,
    authorised_pollutant_tombstone_prefixes: authorisedPrefixes,
  };
}

export function genericV2TransitionStateFingerprintPayload(runState, env = process.env) {
  if (runState?.execution_path !== "generic_integrity") {
    throw new Error("Generic fixed-v2 fingerprint requires execution_path=generic_integrity");
  }
  return {
    contract_version: GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT,
    execution_path: "generic_integrity",
    history_generation: "v2",
    official_rdata_timestamp_authority:
      requireOfficialRdataTimestampAuthority(runState),
    generic_v2_operational_context:
      requireGenericV2OperationalContext(runState, env).context,
    generic_selected_scope_authority: canonicalGenericV2SelectedScopeAuthority(runState),
    ...coordinatorTransitionStateCommonFingerprintPayload(runState),
  };
}

export function requireOfficialRdataTimestampAuthority(runState) {
  return requireAcceptedOfficialRdataTimestampAuthority(runState);
}

export function requireRetainedV2MaintenanceContext(runState, env = process.env) {
  const context = runState?.retained_v2_maintenance_context;
  const bucket = String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim();
  const normalConfig = authoritativeNormalConfiguration(env);
  const implementationRevision = authenticatedImplementationRevision(env);
  const configuredEnvironment = String(
    env.UK_AQ_ENV_NAME || env.UKAQ_ENV_NAME || env.ENVIRONMENT || "",
  ).trim();
  const configuredGeneration = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim();
  const configuredIndexGeneration = String(
    env.UK_AQ_R2_HISTORY_INDEX_VERSION || configuredGeneration,
  ).trim();
  const checkpoint = runState?.dropbox_currentness?.checkpoint;
  const liveRoot = runState?.dropbox_currentness?.live_observations_root;
  const binding = canonicalBindingVerification(
    runState?.timeseries_binding_pre_repair_verification,
  );
  if (!context || typeof context !== "object" || Array.isArray(context)
      || context.contract_version !== RETAINED_V2_MAINTENANCE_CONTEXT_CONTRACT
      || context.intent !== "retained_v2_official_rdata_maintenance"
      || context.environment !== "TEST"
      || runState?.environment !== "TEST"
      || configuredEnvironment !== "TEST"
      || configuredGeneration !== "v2"
      || configuredIndexGeneration !== "v2"
      || normalConfig.environment !== "TEST"
      || normalConfig.serving_generation !== "v3"
      || normalConfig.index_generation !== "v3"
      || normalConfig.bucket !== bucket
      || bucket !== "uk-aq-history-cic-test"
      || context.bucket !== bucket
      || context.normal_configuration_sha256 !== normalConfig.sha256
      || context.observation_generation !== "v2"
      || context.index_generation !== "v2"
      || context.observations_root !== "history/v2/observations"
      || context.serving_generation !== "v3"
      || context.non_serving_downstream_suppressed !== true
      || !GIT_SHA.test(String(context.implementation_revision || ""))
      || context.implementation_revision !== implementationRevision
      || !Array.isArray(context.selected_scopes)
      || !context.selected_scopes.length
      || canonicalTransitionFingerprintJson(context.core_snapshot_identity)
        !== canonicalTransitionFingerprintJson(runState?.core_snapshot_identity)
      || !String(context.core_snapshot_identity?.core_snapshot_manifest_key || "")
        .startsWith("history/v2/core/")
      || context.timeseries_binding_verification?.status !== "ok"
      || canonicalTransitionFingerprintJson(context.timeseries_binding_verification)
        !== canonicalTransitionFingerprintJson(binding)
      || binding.provider.observation_generation !== "v2"
      || runState?.dropbox_currentness?.allowed !== true
      || runState?.dropbox_currentness?.checkpoint_live_root_match !== true
      || !checkpoint || !liveRoot
      || checkpoint.relative_key
        !== "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/root.json"
      || liveRoot.key !== "history/v2/observations/_manifests/manifest.json"
      || !SHA256.test(String(checkpoint.sha256 || ""))
      || !SHA256.test(String(checkpoint.observations_processed_source_root_hash || ""))
      || !SHA256.test(String(liveRoot.content_hash || ""))
      || context.dropbox_checkpoint_sha256 !== checkpoint.sha256
      || context.dropbox_observations_root_hash
        !== checkpoint.observations_processed_source_root_hash
      || context.live_v2_observations_root_hash !== liveRoot.content_hash
      || context.dropbox_observations_root_hash !== context.live_v2_observations_root_hash
      || runState?.observations_global_operation_lock?.valid !== true
      || canonicalTransitionFingerprintJson(context.observations_global_operation_lock)
        !== canonicalTransitionFingerprintJson(runState.observations_global_operation_lock)) {
    throw new Error("Retained fixed-v2 TEST maintenance authority is incomplete or contradictory");
  }
  const authority = canonicalGenericV2SelectedScopeAuthority(runState);
  const selectedScopes = [...authority.selected_scopes, ...authority.metadata_only_scopes]
    .map((scope) => ({
      day_utc: scope.day_utc,
      connector_id: scope.connector_id,
      pollutant_code: scope.pollutant_code,
    })).sort((left, right) => bytewise(left.day_utc, right.day_utc)
      || left.connector_id - right.connector_id
      || bytewise(left.pollutant_code, right.pollutant_code));
  if (canonicalTransitionFingerprintJson(context.selected_scopes)
      !== canonicalTransitionFingerprintJson(selectedScopes)) {
    throw new Error("Retained fixed-v2 TEST maintenance selected scope changed");
  }
  const projection = {
    contract_version: RETAINED_V2_MAINTENANCE_CONTEXT_CONTRACT,
    intent: "retained_v2_official_rdata_maintenance",
    environment: "TEST",
    bucket,
    normal_configuration_sha256: normalConfig.sha256,
    serving_generation: "v3",
    observation_generation: "v2",
    index_generation: "v2",
    observations_root: "history/v2/observations",
    implementation_revision: context.implementation_revision,
    selected_scopes: context.selected_scopes,
    core_snapshot_identity: context.core_snapshot_identity,
    timeseries_binding_verification: context.timeseries_binding_verification,
    dropbox_checkpoint_sha256: context.dropbox_checkpoint_sha256,
    dropbox_observations_root_hash: context.dropbox_observations_root_hash,
    live_v2_observations_root_hash: context.live_v2_observations_root_hash,
    observations_global_operation_lock: context.observations_global_operation_lock,
    non_serving_downstream_suppressed: true,
    deliberate_retained_v2_divergence: true,
    generation_v2_backup_completion_required: true,
  };
  if (canonicalTransitionFingerprintJson(context)
      !== canonicalTransitionFingerprintJson(projection)) {
    throw new Error("Retained fixed-v2 TEST maintenance context changed");
  }
  return { retained_fixed_v2: true, context: projection };
}

export function requireServingV2LiveContext(runState, env = process.env) {
  const context = runState?.serving_v2_live_context;
  const bucket = String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim();
  const normalConfig = authoritativeNormalConfiguration(env);
  const implementationRevision = authenticatedImplementationRevision(env);
  const configuredEnvironment = String(
    env.UK_AQ_ENV_NAME || env.UKAQ_ENV_NAME || env.ENVIRONMENT || "",
  ).trim();
  const configuredGeneration = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim();
  const configuredIndexGeneration = String(
    env.UK_AQ_R2_HISTORY_INDEX_VERSION || configuredGeneration,
  ).trim();
  const checkpoint = runState?.dropbox_currentness?.checkpoint;
  const liveRoot = runState?.dropbox_currentness?.live_observations_root;
  const binding = canonicalBindingVerification(
    runState?.timeseries_binding_pre_repair_verification,
  );
  if (!context || typeof context !== "object" || Array.isArray(context)
      || context.contract_version !== SERVING_V2_LIVE_CONTEXT_CONTRACT
      || context.intent !== "serving_v2_official_rdata_integrity"
      || context.environment !== "LIVE"
      || runState?.environment !== "LIVE"
      || configuredEnvironment !== "LIVE"
      || configuredGeneration !== "v2"
      || configuredIndexGeneration !== "v2"
      || normalConfig.environment !== "LIVE"
      || normalConfig.serving_generation !== "v2"
      || normalConfig.index_generation !== "v2"
      || normalConfig.bucket !== bucket
      || !bucket || context.bucket !== bucket
      || context.normal_configuration_sha256 !== normalConfig.sha256
      || context.serving_generation !== "v2"
      || context.observation_generation !== "v2"
      || context.index_generation !== "v2"
      || context.observations_root !== "history/v2/observations"
      || !GIT_SHA.test(String(context.implementation_revision || ""))
      || context.implementation_revision !== implementationRevision
      || !Array.isArray(context.selected_scopes)
      || !context.selected_scopes.length
      || canonicalTransitionFingerprintJson(context.core_snapshot_identity)
        !== canonicalTransitionFingerprintJson(runState?.core_snapshot_identity)
      || !String(context.core_snapshot_identity?.core_snapshot_manifest_key || "")
        .startsWith("history/v2/core/")
      || context.timeseries_binding_verification?.status !== "ok"
      || canonicalTransitionFingerprintJson(context.timeseries_binding_verification)
        !== canonicalTransitionFingerprintJson(binding)
      || binding.provider.observation_generation !== "v2"
      || runState?.dropbox_currentness?.allowed !== true
      || runState?.dropbox_currentness?.checkpoint_live_root_match !== true
      || !checkpoint || !liveRoot
      || checkpoint.relative_key
        !== "_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/root.json"
      || liveRoot.key !== "history/v2/observations/_manifests/manifest.json"
      || !SHA256.test(String(checkpoint.sha256 || ""))
      || !SHA256.test(String(checkpoint.observations_processed_source_root_hash || ""))
      || !SHA256.test(String(liveRoot.content_hash || ""))
      || context.dropbox_checkpoint_sha256 !== checkpoint.sha256
      || context.dropbox_observations_root_hash
        !== checkpoint.observations_processed_source_root_hash
      || context.live_v2_observations_root_hash !== liveRoot.content_hash
      || context.dropbox_observations_root_hash !== context.live_v2_observations_root_hash
      || runState?.observations_global_operation_lock?.valid !== true
      || canonicalTransitionFingerprintJson(context.observations_global_operation_lock)
        !== canonicalTransitionFingerprintJson(runState.observations_global_operation_lock)) {
    throw new Error("Serving fixed-v2 LIVE authority is incomplete or contradictory");
  }
  const authority = canonicalGenericV2SelectedScopeAuthority(runState);
  const selectedScopes = [...authority.selected_scopes, ...authority.metadata_only_scopes]
    .map((scope) => ({
      day_utc: scope.day_utc,
      connector_id: scope.connector_id,
      pollutant_code: scope.pollutant_code,
    })).sort((left, right) => bytewise(left.day_utc, right.day_utc)
      || left.connector_id - right.connector_id
      || bytewise(left.pollutant_code, right.pollutant_code));
  if (canonicalTransitionFingerprintJson(context.selected_scopes)
      !== canonicalTransitionFingerprintJson(selectedScopes)) {
    throw new Error("Serving fixed-v2 LIVE selected scope changed");
  }
  const projection = {
    contract_version: SERVING_V2_LIVE_CONTEXT_CONTRACT,
    intent: "serving_v2_official_rdata_integrity",
    environment: "LIVE",
    bucket,
    normal_configuration_sha256: normalConfig.sha256,
    serving_generation: "v2",
    observation_generation: "v2",
    index_generation: "v2",
    observations_root: "history/v2/observations",
    implementation_revision: context.implementation_revision,
    selected_scopes: context.selected_scopes,
    core_snapshot_identity: context.core_snapshot_identity,
    timeseries_binding_verification: context.timeseries_binding_verification,
    dropbox_checkpoint_sha256: context.dropbox_checkpoint_sha256,
    dropbox_observations_root_hash: context.dropbox_observations_root_hash,
    live_v2_observations_root_hash: context.live_v2_observations_root_hash,
    observations_global_operation_lock: context.observations_global_operation_lock,
    non_serving_downstream_suppressed: false,
    normal_downstream_eligible_after_final_verification: true,
    generation_v2_backup_completion_required: true,
  };
  if (canonicalTransitionFingerprintJson(context)
      !== canonicalTransitionFingerprintJson(projection)) {
    throw new Error("Serving fixed-v2 LIVE context changed");
  }
  return { serving_fixed_v2: true, context: projection };
}

export function requireGenericV2OperationalContext(runState, env = process.env) {
  const operational = runState?.generic_v2_operational_context;
  if (!operational || typeof operational !== "object" || Array.isArray(operational)
      || operational.contract_version !== GENERIC_V2_OPERATIONAL_CONTEXT_CONTRACT
      || !["retained_v2_non_serving_test", "serving_v2_live"].includes(
        operational.mode,
      )) {
    throw new Error("Generic fixed-v2 operational context is unavailable");
  }
  const selected = operational.mode === "retained_v2_non_serving_test"
    ? requireRetainedV2MaintenanceContext(runState, env).context
    : requireServingV2LiveContext(runState, env).context;
  const projection = {
    contract_version: GENERIC_V2_OPERATIONAL_CONTEXT_CONTRACT,
    mode: operational.mode,
    authority_contract_version: selected.contract_version,
    authority: selected,
  };
  if (canonicalTransitionFingerprintJson(operational)
      !== canonicalTransitionFingerprintJson(projection)) {
    throw new Error("Generic fixed-v2 operational context changed or crossed modes");
  }
  return { mode: operational.mode, context: projection };
}

export function computeGenericV2TransitionStateFingerprint(runState, env = process.env) {
  return sha256(Buffer.from(
    canonicalTransitionFingerprintJson(genericV2TransitionStateFingerprintPayload(runState, env)),
    "utf8",
  ));
}

export function requireGenericV2CoordinatorFreeze(runState, env = process.env) {
  if (runState?.execution_path !== "generic_integrity"
      || runState?.dedicated_sos_historical_replacement !== false
      || !["TEST", "LIVE"].includes(runState?.environment)) {
    throw new Error("Generic fixed-v2 execution or environment authority is invalid");
  }
  if (runState.apply !== undefined && runState.apply !== null) {
    throw new Error(
      "Generic fixed-v2 run already has APPLY state; recovery requires a fresh Integrity run",
    );
  }
  const configuredEnvironment = String(
    env.UK_AQ_ENV_NAME || env.UKAQ_ENV_NAME || env.ENVIRONMENT || "",
  ).trim();
  if (!["TEST", "LIVE"].includes(configuredEnvironment)
      || configuredEnvironment !== runState.environment) {
    throw new Error("Generic fixed-v2 configured environment disagrees with run state");
  }
  const ingestion = runState?.proposal_ingestion;
  if (ingestion?.status !== "complete"
      || ingestion?.transport_mode !== "file_backed_compact_proposal"
      || ingestion?.node_apply_launch_permitted !== false
      || !Number.isSafeInteger(Number(ingestion?.completed_object_count))
      || Number(ingestion.completed_object_count) !== Number(ingestion.total_object_count)) {
    throw new Error("Generic fixed-v2 proposal ingestion checkpoint is incomplete");
  }
  const provenance = runState?.final_staged_write_set_provenance;
  if (provenance?.status !== "finalised"
      || Number(provenance.final_staged_object_count)
        !== Object.keys(runState?.objects || {}).length) {
    throw new Error("Generic fixed-v2 final staged write-set provenance is incomplete");
  }
  const transition = runState?.proposal_transition_validation;
  if (transition?.status !== "succeeded" || transition?.node_apply_launch_permitted !== true
      || transition?.state_fingerprint_contract_version
        !== GENERIC_INTEGRITY_V2_TRANSITION_STATE_FINGERPRINT_CONTRACT
      || !SHA256.test(String(transition?.state_fingerprint_sha256 || ""))) {
    throw new Error("Generic fixed-v2 coordinator transition validation is not frozen");
  }
  requireGenericV2OperationalContext(runState, env);
  const actual = computeGenericV2TransitionStateFingerprint(runState, env);
  if (actual !== transition.state_fingerprint_sha256) {
    throw new Error("Generic fixed-v2 coordinator transition evidence is stale or changed");
  }
  return { generic_fixed_v2: true, authority: canonicalGenericV2SelectedScopeAuthority(runState) };
}

export function validateLocalGenericV2Proposal(runState, env = process.env) {
  requireGenericV2CoordinatorFreeze(runState, env);
  const authority = canonicalGenericV2SelectedScopeAuthority(runState);
  const proposal = validateLocalProposal(runState, { generation: "v2" });
  const byPrefix = new Map(authority.selected_scopes.map((scope) => [
    `history/v2/observations/day_utc=${scope.day_utc}`
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
      throw new Error(`Generic fixed-v2 tombstone justification is invalid: ${prefix}`);
    }
  }
  const objectKeys = new Set(proposal.objects.map((object) => object.key));
  for (const [prefix, scope] of byPrefix) {
    const actualKeys = [...objectKeys].filter((key) => key.startsWith(`${prefix}/`)).sort(bytewise);
    if (!exactArray(actualKeys, scope.replacement_object_keys)) {
      throw new Error(`Generic fixed-v2 selected replacement closure changed: ${prefix}`);
    }
    validatePersistedScopeSourceEvidence(runState, scope);
    if (scope.outcome === "source_artifact_unavailable_preserved") {
      const evidence = deriveGenericPreservedScopeEvidence(runState, {
        dayUtc: scope.day_utc,
        connectorId: scope.connector_id,
        pollutantCode: scope.pollutant_code,
      });
      if (canonicalTransitionFingerprintJson(evidence)
          !== canonicalTransitionFingerprintJson(scope.preservation_evidence)) {
        throw new Error(`Generic fixed-v2 preserved scope evidence changed: ${prefix}`);
      }
    }
  }
  return proposal;
}

export async function validateFinalGenericV2ProposalGraph({ runState, proposal }) {
  const authority = canonicalGenericV2SelectedScopeAuthority(runState);
  return await validateFinalProposalGraph({
    runState,
    proposal,
    genericSelectedScopeAuthority: authority,
  });
}
