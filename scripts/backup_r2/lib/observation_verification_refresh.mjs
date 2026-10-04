// @ts-nocheck -- repository-owned Node operator helpers.

import {
  buildObservationVerificationLatestPublication,
  publishObservationVerificationConnectorManifest,
  publishObservationVerificationLatest,
} from "../../../workers/shared/uk_aq_observation_verification_publication.mjs";

const SOURCE_CONNECTORS = Object.freeze({ sos: 1, waqn: 9, saqn: 10 });

function sortedNumbers(values) {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function identityEqual(left, right) {
  return Number(left?.connector_id) === Number(right?.connector_id) &&
    left?.key === right?.key && Number(left?.byte_size) === Number(right?.byte_size) &&
    left?.sha256 === right?.sha256;
}

function entryStatusAt(entry, observedAtUtc) {
  for (const period of entry.periods || []) {
    if (
      (period.from_observed_at_utc === null || observedAtUtc >= period.from_observed_at_utc) &&
      (period.to_observed_at_utc === null || observedAtUtc < period.to_observed_at_utc)
    ) return period.status;
  }
  return entry.default_status;
}

function comparisonInstants(left, right) {
  const boundaries = new Set();
  for (const entry of [left, right]) {
    for (const period of entry?.periods || []) {
      if (period.from_observed_at_utc) boundaries.add(period.from_observed_at_utc);
      if (period.to_observed_at_utc) boundaries.add(period.to_observed_at_utc);
    }
  }
  const sorted = Array.from(boundaries).sort();
  if (!sorted.length) return ["1970-01-01T00:00:00.000Z"];
  const before = new Date(new Date(sorted[0]).getTime() - 1).toISOString();
  return [before, ...sorted];
}

function semanticEntryWithoutProvenance(entry) {
  return JSON.stringify({
    connector_id: entry.connector_id,
    timeseries_id: entry.timeseries_id,
    station_id: entry.station_id,
    pollutant_code: entry.pollutant_code,
    source_verification_model: entry.source_verification_model,
    default_status: entry.default_status,
    periods: entry.periods,
  });
}

function ratifiedTo(entry) {
  const value = entry?.source_provenance?.ratified_to;
  if (value === null || value === undefined || value === "" ||
      String(value).toLowerCase() === "never") return null;
  return String(value);
}

export function sourceConnectorId(source) {
  const normalized = String(source || "").trim().toLowerCase();
  if (!Object.hasOwn(SOURCE_CONNECTORS, normalized)) {
    throw new Error(`source must be one of: ${Object.keys(SOURCE_CONNECTORS).join(", ")}`);
  }
  return SOURCE_CONNECTORS[normalized];
}

export function normalizeAurnVerificationStatus(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "P";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "p" || normalized === "provisional") return "P";
  if (normalized === "r" || normalized === "ratified") return "R";
  throw new Error(`Unsupported AURN source verification status: ${JSON.stringify(String(value))}`);
}

export function assertPublishEnvironment({ environment, publish }) {
  const normalized = String(environment || "").trim().toUpperCase();
  if (normalized !== "TEST" && normalized !== "LIVE") {
    throw new Error("environment must be TEST or LIVE");
  }
  if (publish && normalized === "LIVE") {
    throw new Error("LIVE observation-verification publication is disabled pending TEST acceptance");
  }
  return normalized;
}

export function assertSosAcquisitionBindingsComplete(acquisition) {
  const warnings = Array.isArray(acquisition?.warnings) ? acquisition.warnings : [];
  const blockers = warnings.filter((warning) => {
    const classification = String(warning?.classification || "").trim().toLowerCase();
    return Number(warning?.target_day_non_null_row_count || 0) > 0 && [
      "no_authoritative_timeseries_binding",
      "missing_binding",
      "ambiguous_binding",
    ].includes(classification);
  });
  if (blockers.length) {
    throw new Error(
      `SOS source acquisition has non-null rows without an unambiguous authoritative binding: ${JSON.stringify(blockers.slice(0, 10))}`,
    );
  }
  return acquisition;
}

export function compareObservationVerificationCandidates({
  source,
  currentManifest = null,
  currentManifestIdentity = null,
  candidateManifest,
  candidateManifestIdentity,
  coverageReadiness,
}) {
  const connectorId = sourceConnectorId(source);
  if (Number(candidateManifest?.connector_id) !== connectorId) {
    throw new Error("candidate connector does not match source");
  }
  if (currentManifest && Number(currentManifest.connector_id) !== connectorId) {
    throw new Error("current connector does not match source");
  }
  const oldById = new Map((currentManifest?.timeseries || []).map((entry) => [entry.timeseries_id, entry]));
  const newById = new Map((candidateManifest.timeseries || []).map((entry) => [entry.timeseries_id, entry]));
  const oldIds = Array.from(oldById.keys());
  const newIds = Array.from(newById.keys());
  const added = sortedNumbers(newIds.filter((id) => !oldById.has(id)));
  const removed = sortedNumbers(oldIds.filter((id) => !newById.has(id)));
  const progressed = [];
  const regressed = [];
  const otherChanged = [];
  const backwardsRatifiedTo = [];
  for (const timeseriesId of oldIds.filter((id) => newById.has(id))) {
    const oldEntry = oldById.get(timeseriesId);
    const newEntry = newById.get(timeseriesId);
    let hasProgression = false;
    let hasRegression = false;
    for (const instant of comparisonInstants(oldEntry, newEntry)) {
      const oldStatus = entryStatusAt(oldEntry, instant);
      const newStatus = entryStatusAt(newEntry, instant);
      if (oldStatus === "P" && newStatus === "R") hasProgression = true;
      if (oldStatus === "R" && newStatus === "P") hasRegression = true;
    }
    if (hasProgression) progressed.push(timeseriesId);
    if (hasRegression) regressed.push(timeseriesId);
    if (
      JSON.stringify(oldEntry) !== JSON.stringify(newEntry) &&
      !hasProgression && !hasRegression
    ) otherChanged.push(timeseriesId);
    if (source === "waqn" || source === "saqn") {
      const oldBoundary = ratifiedTo(oldEntry);
      const newBoundary = ratifiedTo(newEntry);
      if (oldBoundary && (!newBoundary || newBoundary < oldBoundary)) {
        backwardsRatifiedTo.push(timeseriesId);
      }
    }
    if (
      semanticEntryWithoutProvenance(oldEntry) === semanticEntryWithoutProvenance(newEntry) &&
      JSON.stringify(oldEntry.source_provenance) !== JSON.stringify(newEntry.source_provenance)
    ) otherChanged.push(timeseriesId);
  }
  const semanticChange = !currentManifestIdentity ||
    currentManifestIdentity.sha256 !== candidateManifestIdentity.sha256;
  const requiresCorrection = source === "sos" && regressed.length > 0;
  const blockers = [];
  if (coverageReadiness?.publishable !== true) {
    blockers.push(coverageReadiness?.reason || "source coverage/readiness is not proven");
  }
  if (regressed.length) blockers.push("effective R to P regression");
  if (backwardsRatifiedTo.length) blockers.push("backwards ratified_to movement");
  if (removed.length) blockers.push("previously authoritative timeseries removed");
  return Object.freeze({
    source,
    connector_id: connectorId,
    old_manifest_sha256: currentManifestIdentity?.sha256 || null,
    new_manifest_sha256: candidateManifestIdentity.sha256,
    manifest_unchanged: !semanticChange,
    semantic_change: semanticChange,
    existing_timeseries_count: oldIds.length,
    candidate_timeseries_count: newIds.length,
    new_timeseries_ids: added,
    removed_timeseries_ids: removed,
    effective_p_to_r_timeseries_ids: sortedNumbers(progressed),
    effective_r_to_p_timeseries_ids: sortedNumbers(regressed),
    backwards_ratified_to_timeseries_ids: sortedNumbers(backwardsRatifiedTo),
    other_changed_period_or_provenance_timeseries_ids: sortedNumbers(otherChanged),
    requires_explicit_correction_authority: requiresCorrection,
    coverage_readiness: coverageReadiness || { publishable: false, reason: "missing readiness result" },
    blockers,
    publishable: blockers.length === 0,
  });
}

export async function buildVerificationPublicationPlan({
  comparison,
  candidatePublication,
  currentLatest = null,
  authenticatedCurrentConnectorIdentities = [],
}) {
  if (!comparison.semantic_change) {
    return Object.freeze({
      publication_intent: false,
      connector: null,
      expected_current_target: null,
      initial_current_latest: null,
    });
  }
  if (!comparison.publishable) {
    throw new Error(`verification candidate is not publishable: ${comparison.blockers.join("; ")}`);
  }
  const current = Array.isArray(currentLatest?.connectors) ? currentLatest.connectors : [];
  const authenticated = authenticatedCurrentConnectorIdentities || [];
  for (const identity of current) {
    if (!authenticated.some((candidate) => identityEqual(candidate, identity))) {
      throw new Error(`current connector identity was not authenticated: connector_id=${identity.connector_id}`);
    }
  }
  const targetConnectorId = Number(candidatePublication.latest_identity.connector_id);
  return Object.freeze({
    publication_intent: true,
    connector: candidatePublication,
    expected_current_target: current.find((identity) =>
      Number(identity.connector_id) === targetConnectorId) || null,
    initial_current_latest: currentLatest,
  });
}

export async function executeVerificationPublication({
  publish,
  environment,
  plan,
  r2 = null,
  withPublicationLock = null,
  refreshCurrentAuthority = null,
  publishConnector = publishObservationVerificationConnectorManifest,
  publishLatest = publishObservationVerificationLatest,
}) {
  const normalizedEnvironment = assertPublishEnvironment({ environment, publish });
  if (!publish) return Object.freeze({ status: "build_only", environment: normalizedEnvironment, objects_written: 0 });
  if (!plan?.publication_intent) {
    return Object.freeze({ status: "unchanged", environment: normalizedEnvironment, objects_written: 0 });
  }
  if (typeof refreshCurrentAuthority !== "function") {
    throw new Error("publication requires a locked current-authority refresh callback");
  }
  if (typeof withPublicationLock !== "function") {
    throw new Error("publication requires the observations global operation lock");
  }
  return withPublicationLock(async ({ assertHeld = () => {} } = {}) => {
    assertHeld();
    const durableCandidate = await publishConnector({ r2, publication: plan.connector });
    assertHeld();
    const refreshed = await refreshCurrentAuthority();
    if (refreshed?.status === "unavailable") {
      throw new Error(`current verification authority became unavailable: ${refreshed.reason || "unknown"}`);
    }
    const current = Array.isArray(refreshed?.latest?.connectors)
      ? refreshed.latest.connectors
      : [];
    const authenticated = refreshed?.authenticated || [];
    for (const identity of current) {
      if (!authenticated.some((candidate) => identityEqual(candidate, identity))) {
        throw new Error(`refreshed connector identity was not authenticated: connector_id=${identity.connector_id}`);
      }
    }
    const targetConnectorId = Number(plan.connector.latest_identity.connector_id);
    const refreshedTarget = current.find((identity) =>
      Number(identity.connector_id) === targetConnectorId) || null;
    if (
      (plan.expected_current_target === null) !== (refreshedTarget === null) ||
      (plan.expected_current_target && !identityEqual(plan.expected_current_target, refreshedTarget))
    ) {
      throw new Error("target connector authority changed before locked latest composition; rerun comparison");
    }
    const preserved = current.filter((identity) =>
      Number(identity.connector_id) !== targetConnectorId);
    const latest = await buildObservationVerificationLatestPublication({
      connectorManifestIdentities: [...preserved, plan.connector.latest_identity],
    });
    assertHeld();
    const durablePreserved = preserved.map((identity) => ({ ...identity, verified: true }));
    const durableLatest = await publishLatest({
      r2,
      publication: latest,
      durableConnectorManifests: [...durablePreserved, durableCandidate],
    });
    assertHeld();
    return Object.freeze({
      status: "published",
      environment: normalizedEnvironment,
      objects_written: 2,
      durable_connector: durableCandidate,
      durable_latest: durableLatest,
    });
  });
}
