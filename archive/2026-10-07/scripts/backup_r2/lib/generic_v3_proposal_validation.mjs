/** Generic fixed-v3 selected-scope proposal validation boundary. */
import { createHash } from "node:crypto";

import {
  validateFinalProposalGraph,
  validateLocalProposal,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  canonicalTransitionFingerprintJson,
  coordinatorTransitionStateCommonFingerprintPayload,
} from "./sos_light_v3_proposal_validation.mjs";

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
  "uk_aq_generic_integrity_v3_transition_state_fingerprint_v1";
export const GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT =
  "uk_aq_generic_integrity_v3_selected_scope_authority_v1";

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

export function canonicalGenericV3SelectedScopeAuthority(runState) {
  const authority = runState?.generic_integrity_selected_scope_authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
      || authority.contract_version !== GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT
      || authority.history_generation !== "v3"
      || !Array.isArray(authority.selected_scopes) || !authority.selected_scopes.length
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
    const authorisedPrefix = scope.authorised_tombstone_prefix;
    if (outcome === "source_artifact_unavailable_preserved") {
      if (authorisedPrefix !== null) {
        throw new Error("Generic fixed-v3 preserved scope has deletion authority");
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
    return {
      day_utc: dayUtc,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      outcome,
      authorised_tombstone_prefix: authorisedPrefix,
      replacement_object_keys: replacementKeys,
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
  return {
    contract_version: GENERIC_INTEGRITY_V3_SELECTED_SCOPE_AUTHORITY_CONTRACT,
    history_generation: "v3",
    selected_scopes: scopes,
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
    env.UK_AQ_ENV_NAME || env.UKAQ_ENV_NAME || env.ENVIRONMENT || "",
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
      const preservedIdentity = proposal.objects.some((object) =>
        Object.entries(object.entry?.dependency_identities || {}).some(([key, identity]) =>
          key.startsWith(`${prefix}/`) && ["dropbox", "overlay"].includes(identity?.source)));
      if (!preservedIdentity) {
        throw new Error(`Generic fixed-v3 preserved scope lacks an authenticated external dependency: ${prefix}`);
      }
    }
  }
  return proposal;
}

export async function validateFinalGenericV3ProposalGraph({ runState, proposal }) {
  const authority = canonicalGenericV3SelectedScopeAuthority(runState);
  return await validateFinalProposalGraph({
    runState,
    proposal,
    genericSelectedScopeAuthority: authority,
  });
}
