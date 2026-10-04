import assert from "node:assert/strict";
import test from "node:test";

import {
  buildObservationVerificationRefreshInputs,
  verificationPeriodsFromObservationEvidence,
  verificationPeriodsFromRatifiedTo,
} from "../workers/shared/uk_aq_observation_verification_overlay.mjs";
import {
  buildObservationVerificationConnectorPublication,
} from "../workers/shared/uk_aq_observation_verification_publication.mjs";
import {
  assertPublishEnvironment,
  assertSosAcquisitionBindingsComplete,
  buildVerificationPublicationPlan,
  compareObservationVerificationCandidates,
  executeVerificationPublication,
  normalizeAurnVerificationStatus,
} from "../scripts/backup_r2/lib/observation_verification_refresh.mjs";

function entry({
  connectorId = 9,
  timeseriesId = 9001,
  stationId = 901,
  pollutantCode = "no2",
  ratifiedTo = "2026-06-30",
} = {}) {
  const authority = verificationPeriodsFromRatifiedTo(ratifiedTo, {
    semanticSourceProvenance: {
      source_system: "official-network-rdata",
      network: connectorId === 10 ? "saqn" : "waqn",
      site_id: `SITE${stationId}`,
      parameter: pollutantCode.toUpperCase(),
    },
  });
  return {
    connector_id: connectorId,
    timeseries_id: timeseriesId,
    station_id: stationId,
    pollutant_code: pollutantCode,
    ...authority,
  };
}

function manifest(connectorId, timeseries) {
  return buildObservationVerificationRefreshInputs({
    connectorId,
    semanticSourceIdentity: {
      source_system: connectorId === 1 ? "uk-air-annual-csv" : "official-network-rdata",
      connector_id: connectorId,
      verification_model: connectorId === 1
        ? "per-observation-status-v1"
        : "ratification-boundary-v1",
    },
    timeseries,
    acquisitionEvidence: {},
  }).canonical_manifest;
}

async function publication(connectorId, timeseries) {
  return buildObservationVerificationConnectorPublication({
    manifest: manifest(connectorId, timeseries),
  });
}

test("shared source conversions preserve official boundaries and arbitrary AURN transitions", () => {
  const boundary = verificationPeriodsFromRatifiedTo("2026-06-30");
  assert.deepEqual(boundary.periods, [{
    from_observed_at_utc: null,
    to_observed_at_utc: "2026-07-01T00:00:00.000Z",
    status: "R",
  }]);
  for (const missing of [null, "", "Never"]) {
    const provisional = verificationPeriodsFromRatifiedTo(missing);
    assert.equal(provisional.default_status, "P");
    assert.deepEqual(provisional.periods, []);
  }
  const transitions = verificationPeriodsFromObservationEvidence([
    { observed_at_utc: "2026-01-01T01:00:00.000Z", status: "P" },
    { observed_at_utc: "2026-01-01T02:00:00.000Z", status: "P" },
    { observed_at_utc: "2026-01-01T03:00:00.000Z", status: "R" },
    { observed_at_utc: "2026-01-01T04:00:00.000Z", status: "P" },
    { observed_at_utc: "2026-01-01T05:00:00.000Z", status: "R" },
  ]);
  assert.deepEqual(transitions.periods.map((period) => period.status), ["P", "R", "P", "R"]);
});

test("AURN raw status admission is explicit and fails closed", () => {
  assert.equal(normalizeAurnVerificationStatus(" provisional "), "P");
  assert.equal(normalizeAurnVerificationStatus("R"), "R");
  assert.equal(normalizeAurnVerificationStatus(""), "P");
  assert.throws(() => normalizeAurnVerificationStatus("P*"), /unsupported AURN/i);
  assert.throws(() => normalizeAurnVerificationStatus("As supplied"), /unsupported AURN/i);
});

test("comparison permits progression and blocks regression, backwards boundary, and removal", async () => {
  const oldPublication = await publication(9, [entry({ ratifiedTo: "2026-06-30" })]);
  const progressedPublication = await publication(9, [entry({ ratifiedTo: "2026-07-31" })]);
  const progressed = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry({ ratifiedTo: "2026-06-30" })]),
    currentManifestIdentity: oldPublication.latest_identity,
    candidateManifest: manifest(9, [entry({ ratifiedTo: "2026-07-31" })]),
    candidateManifestIdentity: progressedPublication.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  assert.equal(progressed.publishable, true);
  assert.deepEqual(progressed.effective_p_to_r_timeseries_ids, [9001]);
  assert.deepEqual(progressed.effective_r_to_p_timeseries_ids, []);

  const regressedPublication = await publication(9, [entry({ ratifiedTo: "2026-05-31" })]);
  const regressed = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry({ ratifiedTo: "2026-06-30" })]),
    currentManifestIdentity: oldPublication.latest_identity,
    candidateManifest: manifest(9, [entry({ ratifiedTo: "2026-05-31" })]),
    candidateManifestIdentity: regressedPublication.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  assert.equal(regressed.publishable, false);
  assert.deepEqual(regressed.effective_r_to_p_timeseries_ids, [9001]);
  assert.deepEqual(regressed.backwards_ratified_to_timeseries_ids, [9001]);

  const removedPublication = await publication(9, []);
  const removed = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry()]),
    currentManifestIdentity: oldPublication.latest_identity,
    candidateManifest: manifest(9, []),
    candidateManifestIdentity: removedPublication.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  assert.equal(removed.publishable, false);
  assert.deepEqual(removed.removed_timeseries_ids, [9001]);
});

test("AURN R to P requires explicit correction authority", async () => {
  const aurnEntry = (statuses) => ({
    connector_id: 1,
    timeseries_id: 101,
    station_id: 11,
    pollutant_code: "no2",
    ...verificationPeriodsFromObservationEvidence(statuses, {
      semanticSourceProvenance: {
        source_system: "uk-air-annual-csv",
        site_ref: "ABCD",
        pollutant_code: "no2",
      },
    }),
  });
  const oldEntry = aurnEntry([
    { observed_at_utc: "2020-01-01T01:00:00.000Z", status: "R" },
  ]);
  const newEntry = aurnEntry([
    { observed_at_utc: "2020-01-01T01:00:00.000Z", status: "R" },
    { observed_at_utc: "2020-01-02T01:00:00.000Z", status: "P" },
  ]);
  const oldPublication = await publication(1, [oldEntry]);
  const newPublication = await publication(1, [newEntry]);
  const comparison = compareObservationVerificationCandidates({
    source: "sos",
    currentManifest: manifest(1, [oldEntry]),
    currentManifestIdentity: oldPublication.latest_identity,
    candidateManifest: manifest(1, [newEntry]),
    candidateManifestIdentity: newPublication.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  assert.equal(comparison.publishable, false);
  assert.equal(comparison.requires_explicit_correction_authority, true);
});

test("unchanged authority has no publication intent", async () => {
  const current = await publication(9, [entry()]);
  const comparison = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry()]),
    currentManifestIdentity: current.latest_identity,
    candidateManifest: manifest(9, [entry()]),
    candidateManifestIdentity: current.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  const plan = await buildVerificationPublicationPlan({
    comparison,
    candidatePublication: current,
    currentLatest: { connectors: [current.latest_identity] },
    authenticatedCurrentConnectorIdentities: [current.latest_identity],
  });
  assert.equal(comparison.semantic_change, false);
  assert.equal(plan.publication_intent, false);
  assert.equal(plan.connector, null);
  assert.equal(plan.expected_current_target, null);
});

test("latest is composed after durable connector verification and preserves refreshed unrelated identities", async () => {
  const connector1 = await publication(1, []);
  const old9 = await publication(9, [entry()]);
  const connector10 = await publication(10, [entry({ connectorId: 10, timeseriesId: 10001 })]);
  const refreshed10 = await publication(10, [entry({
    connectorId: 10,
    timeseriesId: 10001,
    ratifiedTo: "2026-07-31",
  })]);
  const new9 = await publication(9, [entry({ ratifiedTo: "2026-07-31" })]);
  const comparison = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry()]),
    currentManifestIdentity: old9.latest_identity,
    candidateManifest: manifest(9, [entry({ ratifiedTo: "2026-07-31" })]),
    candidateManifestIdentity: new9.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  const authenticated = [connector1.latest_identity, old9.latest_identity, connector10.latest_identity];
  const plan = await buildVerificationPublicationPlan({
    comparison,
    candidatePublication: new9,
    currentLatest: { connectors: authenticated },
    authenticatedCurrentConnectorIdentities: authenticated,
  });
  const events = [];
  let latestPublication = null;
  await executeVerificationPublication({
    publish: true,
    environment: "TEST",
    plan,
    withPublicationLock: async (callback) => {
      events.push("lock");
      return callback({ assertHeld: () => {} });
    },
    publishConnector: async () => {
      events.push("connector");
      return { ...new9.latest_identity, verified: true };
    },
    refreshCurrentAuthority: async () => {
      events.push("refresh");
      const refreshed = [connector1.latest_identity, old9.latest_identity, refreshed10.latest_identity];
      return {
        status: "authenticated",
        latest: { connectors: refreshed },
        authenticated: refreshed,
      };
    },
    publishLatest: async ({ publication: value }) => {
      events.push("latest");
      latestPublication = value;
      return { ...value.artifact, verified: true };
    },
  });
  assert.deepEqual(events, ["lock", "connector", "refresh", "latest"]);
  assert.deepEqual(
    latestPublication.payload.connectors.filter((item) => item.connector_id !== 9),
    [connector1.latest_identity, refreshed10.latest_identity],
  );
  await assert.rejects(
    buildVerificationPublicationPlan({
      comparison,
      candidatePublication: new9,
      currentLatest: { connectors: authenticated },
      authenticatedCurrentConnectorIdentities: [old9.latest_identity],
    }),
    /authenticated/i,
  );
});

test("locked publication aborts if target authority changed after comparison", async () => {
  const old9 = await publication(9, [entry()]);
  const new9 = await publication(9, [entry({ ratifiedTo: "2026-07-31" })]);
  const other9 = await publication(9, [entry({ ratifiedTo: "2026-08-31" })]);
  const comparison = compareObservationVerificationCandidates({
    source: "waqn",
    currentManifest: manifest(9, [entry()]),
    currentManifestIdentity: old9.latest_identity,
    candidateManifest: manifest(9, [entry({ ratifiedTo: "2026-07-31" })]),
    candidateManifestIdentity: new9.latest_identity,
    coverageReadiness: { publishable: true, reason: null },
  });
  const plan = await buildVerificationPublicationPlan({
    comparison,
    candidatePublication: new9,
    currentLatest: { connectors: [old9.latest_identity] },
    authenticatedCurrentConnectorIdentities: [old9.latest_identity],
  });
  let latestCalls = 0;
  await assert.rejects(executeVerificationPublication({
    publish: true,
    environment: "TEST",
    plan,
    withPublicationLock: async (callback) => callback({ assertHeld: () => {} }),
    publishConnector: async () => ({ ...new9.latest_identity, verified: true }),
    refreshCurrentAuthority: async () => ({
      status: "authenticated",
      latest: { connectors: [other9.latest_identity] },
      authenticated: [other9.latest_identity],
    }),
    publishLatest: async () => { latestCalls += 1; },
  }), /changed before locked latest composition/i);
  assert.equal(latestCalls, 0);
});

test("unproven first-publication coverage and SOS missing bindings fail closed", async () => {
  const candidate = await publication(9, [entry()]);
  const comparison = compareObservationVerificationCandidates({
    source: "waqn",
    candidateManifest: manifest(9, [entry()]),
    candidateManifestIdentity: candidate.latest_identity,
    coverageReadiness: {
      publishable: false,
      reason: "retained canonical connector scope is not authenticated",
    },
  });
  assert.equal(comparison.publishable, false);
  assert.match(comparison.blockers[0], /retained canonical/i);
  assert.throws(() => assertSosAcquisitionBindingsComplete({
    warnings: [{
      classification: "no_authoritative_timeseries_binding",
      target_day_non_null_row_count: 3,
      site_ref: "ABCD",
    }],
  }), /without an unambiguous authoritative binding/i);
});

test("build-only and LIVE publication both fail before any PUT", async () => {
  let calls = 0;
  const putConnector = async () => { calls += 1; };
  const putLatest = async () => { calls += 1; };
  const buildOnly = await executeVerificationPublication({
    publish: false,
    environment: "TEST",
    plan: { publication_intent: true },
    publishConnector: putConnector,
    publishLatest: putLatest,
  });
  assert.equal(buildOnly.status, "build_only");
  assert.equal(calls, 0);
  assert.throws(() => assertPublishEnvironment({ environment: "LIVE", publish: true }), /LIVE/i);
  await assert.rejects(
    executeVerificationPublication({
      publish: true,
      environment: "LIVE",
      plan: { publication_intent: true },
      publishConnector: putConnector,
      publishLatest: putLatest,
    }),
    /LIVE/i,
  );
  assert.equal(calls, 0);
  await assert.rejects(executeVerificationPublication({
    publish: true,
    environment: "TEST",
    plan: { publication_intent: true },
    refreshCurrentAuthority: async () => ({ status: "pre_overlay" }),
    publishConnector: putConnector,
    publishLatest: putLatest,
  }), /global operation lock/i);
  assert.equal(calls, 0);
});
