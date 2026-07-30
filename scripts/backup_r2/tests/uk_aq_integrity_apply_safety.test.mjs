import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyValidatedProposal,
  assertPublicationDependenciesVerified,
  createVerifiedGetBodyCache,
  publicationRank,
  validateFinalProposalGraph,
  validateLocalProposal,
  verifyLiveObservationPartition,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  createStagedObjectMap,
} from "../uk_aq_execute_v2_observations_repair_impl.mjs";
import {
  finaliseLegacyObservationManifestCompatibility,
} from "../../../workers/uk_aq_backfill_local/r2_history/metadata_repair.mjs";
import {
  inspectSourceDerivedObservationManifestOwner,
} from "../../../workers/uk_aq_backfill_local/r2_history/proposal_ownership.mjs";
import {
  computeObservationContentHash,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  buildHistoryV2PollutantManifest,
  serializeCanonicalObservationV2Parquet,
} from "../../../workers/shared/uk_aq_r2_history_canonical.mjs";

function writeObject(root, key, body) {
  const filePath = path.join(root, ...key.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return filePath;
}

function stateEntry(filePath, key, dependencies = [], dependencyIdentities = {}) {
  const body = fs.readFileSync(filePath);
  return {
    object_key: key,
    local_path: filePath,
    proposed: true,
    built: true,
    structurally_validated: true,
    bytes: body.byteLength,
    sha256: sha256Hex(body),
    dependencies,
    dependency_identities: dependencyIdentities,
  };
}

async function observationFixture({ wrongManifest = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-apply-safety-"));
  const overlay = path.join(root, "overlay");
  const dropbox = path.join(root, "dropbox");
  fs.mkdirSync(dropbox, { recursive: true });
  const dayUtc = "2026-06-17";
  const connectorId = 1;
  const pollutantCode = "pm25";
  const prefix = `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const partKey = `${prefix}/part-00000.parquet`;
  const manifestKey = `${prefix}/manifest.json`;
  const rows = [
    { connector_id: 1, station_id: 10, timeseries_id: 100, pollutant_code: "pm25", observed_at_utc: "2026-06-17T00:00:00.000Z", value: 12.5, verification_status: "P" },
    { connector_id: 1, station_id: 10, timeseries_id: 100, pollutant_code: "pm25", observed_at_utc: "2026-06-17T01:00:00.000Z", value: 13.5, verification_status: "P" },
  ];
  const partBody = serializeCanonicalObservationV2Parquet(rows);
  const partPath = writeObject(overlay, partKey, partBody);
  const sourceComputed = computeObservationContentHash(rows);
  const manifestComputed = wrongManifest
    ? computeObservationContentHash(rows.map((row) => ({ ...row, value: row.value + 100 })))
    : sourceComputed;
  const { canonical_rows: _sourceRows, ...sourceMetadata } = sourceComputed;
  const { canonical_rows: _manifestRows, ...manifestMetadata } = manifestComputed;
  const fileEntry = {
    key: partKey,
    row_count: rows.length,
    bytes: partBody.byteLength,
    etag_or_hash: sha256Hex(partBody),
    pollutant_codes: [pollutantCode],
    min_timeseries_id: 100,
    max_timeseries_id: 100,
    min_observed_at_utc: rows[0].observed_at_utc,
    max_observed_at_utc: rows.at(-1).observed_at_utc,
    timeseries_row_counts: { "100": rows.length },
  };
  const manifest = buildHistoryV2PollutantManifest({
    domain: "observations",
    grain: null,
    profile: null,
    dayUtc,
    connectorId,
    pollutantCode,
    runId: "test-run",
    manifestKey,
    sourceRowCount: rows.length,
    fileEntries: [fileEntry],
    writerGitSha: "test",
    backedUpAtUtc: "2026-06-18T00:00:00.000Z",
    observationContentHash: manifestMetadata,
  });
  const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestPath = writeObject(overlay, manifestKey, manifestBody);
  const evidenceDirectory = path.join(overlay, `day_utc=${dayUtc}`, `connector_id=${connectorId}`);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const storedRows = rows.map((row) => ({
    timeseries_id: row.timeseries_id,
    station_id: row.station_id,
    pollutant_code: row.pollutant_code,
    observed_at: row.observed_at_utc,
    value: row.value,
    verification_status: row.verification_status,
  }));
  const sourceRowsBody = Buffer.from(JSON.stringify(storedRows));
  const rowsPath = path.join(evidenceDirectory, "obs_history_rows.json");
  fs.writeFileSync(rowsPath, sourceRowsBody);
  const evidence = {
    schema_version: 1,
    enumeration_complete: true,
    day_utc: dayUtc,
    connector_id: connectorId,
    canonical_rows_bytes: sourceRowsBody.byteLength,
    canonical_rows_sha256: sha256Hex(sourceRowsBody),
    total_rows: rows.length,
    per_pollutant_counts: { [pollutantCode]: rows.length },
    observation_content_hashes: { [pollutantCode]: sourceMetadata },
  };
  fs.writeFileSync(path.join(evidenceDirectory, "source-evidence.json"), JSON.stringify(evidence));
  const partEntry = {
    ...stateEntry(partPath, partKey),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  const manifestEntry = {
    ...stateEntry(manifestPath, manifestKey, [partKey], {
      [partKey]: { sha256: partEntry.sha256, bytes: partEntry.bytes, source: "overlay" },
    }),
    stage: "observations_data",
    proposal_owner: "source_derived_observation_repair",
  };
  const runState = {
    environment: "CIC-Test",
    overlay_root: overlay,
    base_dropbox_root: dropbox,
    objects: { [partKey]: partEntry, [manifestKey]: manifestEntry },
    tombstone_prefixes: [{
      prefix,
      proposed: true,
      repair_pollutants: [pollutantCode],
    }],
  };
  const runStatePath = path.join(root, "run-state.json");
  fs.writeFileSync(runStatePath, JSON.stringify(runState));
  return {
    root,
    runState,
    runStatePath,
    partKey,
    partBody,
    manifestKey,
    manifestBody,
    rowsPath,
    evidencePath: path.join(evidenceDirectory, "source-evidence.json"),
    storedRows,
  };
}

function replaceStoredEvidenceRows(fixture, storedRows) {
  const body = Buffer.from(JSON.stringify(storedRows));
  fs.writeFileSync(fixture.rowsPath, body);
  const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
  evidence.canonical_rows_bytes = body.byteLength;
  evidence.canonical_rows_sha256 = sha256Hex(body);
  evidence.total_rows = storedRows.length;
  fs.writeFileSync(fixture.evidencePath, JSON.stringify(evidence));
}

async function compatibilityFixture({ contentMismatch = false, dependencyMismatch = false } = {}) {
  const fixture = await observationFixture();
  const owned = await inspectSourceDerivedObservationManifestOwner({
    state: fixture.runState,
    manifestKey: fixture.manifestKey,
    overlayRoot: fixture.runState.overlay_root,
  });
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  const root = fixture.root;
  const connectorPath = path.join(root, "connector-manifest.json");
  const key = fixture.manifestKey;
  const connectorKey = "history/v2/observations/day_utc=2026-06-17/connector_id=1/manifest.json";
  const payload = {
    ...owned.payload,
    run_id: "different-planner-run",
    backed_up_at_utc: "2026-06-19T00:00:00.000Z",
    writer_git_sha: "different-writer-sha",
    manifest_hash: "operationally-different-derived-hash",
    ...(contentMismatch ? { source_row_count: owned.payload.source_row_count + 1 } : {}),
  };
  const dependencyIdentities = structuredClone(owned.dependency_identities);
  if (dependencyMismatch) dependencyIdentities[fixture.partKey].sha256 = "a".repeat(64);
  const existing = {
    key,
    kind: "pollutant_manifest",
    proposed_body: JSON.stringify(payload),
    dependencies: owned.dependencies,
    dependency_identities: dependencyIdentities,
    provenance: { source: "source_derived_observation_repair" },
  };
  return {
    key,
    existing,
    output: {
      planning: {
        proposals: [
          existing,
          { key: connectorKey, kind: "connector_manifest", proposed_body: "{}" },
        ],
        days: [],
      },
      results: [],
    },
    preparation: {
      run_state_path: fixture.runStatePath,
      prepared: [{
        day_utc: "2026-06-17",
        connector_id: 1,
        connector_key: connectorKey,
        connector_overlay_path: connectorPath,
        pollutant_proposals: [{
          key,
          retained_source_derived: true,
          content_facts: owned.content_facts,
          dependencies: owned.dependencies,
          dependency_identities: owned.dependency_identities,
          source_manifest_key: key,
          raw_pollutant_code: "pm25",
          pollutant_code: "pm25",
          proposal_owner: "source_derived_observation_repair",
          compatibility_source: "dropbox_canonical_manifest",
        }],
      }],
    },
  };
}

test("compatibility retains an owned source-derived manifest across operational metadata differences", async () => {
  const compatible = await compatibilityFixture();
  const finalised = finaliseLegacyObservationManifestCompatibility(compatible);
  assert.equal(finalised.planning.proposals.find((proposal) => proposal.key === compatible.key), compatible.existing);
  assert.equal(finalised.planning.compatibility_preparation.collisions[0].status, "retained_source_derived");
});

test("compatibility rejects exact source-derived content and dependency mismatches", async () => {
  const contentMismatch = await compatibilityFixture({ contentMismatch: true });
  assert.throws(
    () => finaliseLegacyObservationManifestCompatibility(contentMismatch),
    /Integrity proposal collision:.*differing_fields=source_row_count.*compatibility_source=dropbox_canonical_manifest/,
  );
  const dependencyMismatch = await compatibilityFixture({ dependencyMismatch: true });
  assert.throws(
    () => finaliseLegacyObservationManifestCompatibility(dependencyMismatch),
    /Integrity proposal collision:.*differing_fields=dependency_identities\..*\.sha256.*compatibility_source=dropbox_canonical_manifest/,
  );
});

test("compatibility ownership is independently derived from final staged Parquet", async () => {
  const fixture = await observationFixture();
  const originalManifest = fs.readFileSync(
    fixture.runState.objects[fixture.manifestKey].local_path,
  );
  const owned = await inspectSourceDerivedObservationManifestOwner({
    state: fixture.runState,
    manifestKey: fixture.manifestKey,
    overlayRoot: fixture.runState.overlay_root,
  });
  assert.equal(owned.owner, "source_derived_observation_repair");
  assert.equal(owned.semantic.observation_content_hash, owned.payload.observation_content_hash);
  assert.deepEqual(
    fs.readFileSync(fixture.runState.objects[fixture.manifestKey].local_path),
    originalManifest,
  );
  assert.equal(fixture.runState.objects[fixture.partKey].proposal_owner, "source_derived_observation_repair");
});

test("final proposal graph requires immutable source, staged Parquet and final manifest equality before remote mutation", async () => {
  const valid = await observationFixture();
  const proposal = validateLocalProposal(valid.runState);
  const audit = await validateFinalProposalGraph({ runState: valid.runState, proposal });
  assert.equal(audit.status, "succeeded");
  assert.equal(audit.validated_partition_count, 1);

  const invalid = await observationFixture({ wrongManifest: true });
  let remoteCalls = 0;
  const remote = async () => { remoteCalls += 1; throw new Error("remote adapter must not run"); };
  await assert.rejects(
    applyValidatedProposal({
      runStatePath: invalid.runStatePath,
      r2: {},
      adapters: { deleteObjects: remote, getObject: remote, listAllObjects: remote, putObject: remote },
    }),
    /Final Integrity proposal graph mismatch:.*observation_content_hash/,
  );
  assert.equal(remoteCalls, 0);
  const persisted = JSON.parse(fs.readFileSync(invalid.runStatePath, "utf8"));
  assert.equal(persisted.final_proposal_graph_validation.status, "failed");
});

async function assertApplyFailsBeforeRemote(fixture, expected) {
  let remoteCalls = 0;
  const remote = async () => {
    remoteCalls += 1;
    throw new Error("remote adapter must not run");
  };
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  await assert.rejects(applyValidatedProposal({
    runStatePath: fixture.runStatePath,
    r2: {},
    adapters: { deleteObjects: remote, getObject: remote, listAllObjects: remote, putObject: remote },
  }), expected);
  assert.equal(remoteCalls, 0);
}

test("immutable source adapter rejects invalid, out-of-day, and conflicting-connector stored rows", async () => {
  const invalidTimestamp = await observationFixture();
  assert.equal(Object.hasOwn(invalidTimestamp.storedRows[0], "connector_id"), false);
  assert.equal(Object.hasOwn(invalidTimestamp.storedRows[0], "observed_at_utc"), false);
  invalidTimestamp.storedRows[0].observed_at = "not-a-timestamp";
  replaceStoredEvidenceRows(invalidTimestamp, invalidTimestamp.storedRows);
  await assertApplyFailsBeforeRemote(invalidTimestamp, /observed_at is missing or invalid/);

  const outOfDay = await observationFixture();
  outOfDay.storedRows[0].observed_at = "2026-06-18T00:00:00.000Z";
  replaceStoredEvidenceRows(outOfDay, outOfDay.storedRows);
  await assertApplyFailsBeforeRemote(outOfDay, /observed_at is outside selected UTC day/);

  const conflictingConnector = await observationFixture();
  conflictingConnector.storedRows[0].connector_id = 7;
  replaceStoredEvidenceRows(conflictingConnector, conflictingConnector.storedRows);
  await assertApplyFailsBeforeRemote(conflictingConnector, /conflicting connector_id/);
});

test("final proposal graph requires source-derived partitions and pollutant tombstones in both directions", async () => {
  const missingTombstone = await observationFixture();
  missingTombstone.runState.tombstone_prefixes = [];
  await assertApplyFailsBeforeRemote(missingTombstone, /matching_pollutant_prefix_tombstone/);

  const unmatchedTombstone = await observationFixture();
  delete unmatchedTombstone.runState.objects[unmatchedTombstone.manifestKey];
  await assertApplyFailsBeforeRemote(unmatchedTombstone, /matching_staged_pollutant_manifest/);
});

test("live semantic verification trusts immutable source evidence and classifies a wrong manifest separately", async () => {
  const fixture = await observationFixture({ wrongManifest: true });
  const proposal = validateLocalProposal(fixture.runState);
  const manifestObject = proposal.objects.find((object) => object.key === fixture.manifestKey);
  fixture.runState.objects[fixture.partKey].r2_verified = true;
  fs.writeFileSync(fixture.runStatePath, JSON.stringify(fixture.runState));
  await assert.rejects(
    verifyLiveObservationPartition({
      r2: {},
      runState: fixture.runState,
      runStatePath: fixture.runStatePath,
      object: manifestObject,
      adapters: {
        getObject: async ({ key }) => {
          assert.equal(key, fixture.partKey);
          return { body: fixture.partBody, bytes: fixture.partBody.byteLength };
        },
      },
    }),
    /Proposed observation manifest does not match verified live source content/,
  );
  assert.equal(manifestObject.entry.live_observation_content_verified_against_source, true);
  assert.equal(manifestObject.entry.proposed_manifest_matches_live_observation, false);
  assert.equal(manifestObject.entry.live_observation_failure_classification, "proposal_manifest_defect");
  assert.equal(manifestObject.entry.live_observation_body_sources[0].source, "fresh_get");
});

test("live semantic verification reuses only the exact post-PUT verified body", async () => {
  const fixture = await observationFixture();
  const proposal = validateLocalProposal(fixture.runState);
  const manifestObject = proposal.objects.find((object) => object.key === fixture.manifestKey);
  fixture.runState.objects[fixture.partKey].r2_verified = true;
  const cache = createVerifiedGetBodyCache();
  cache.store({
    key: fixture.partKey,
    sha256: fixture.runState.objects[fixture.partKey].sha256,
    body: fixture.partBody,
  });
  await verifyLiveObservationPartition({
    r2: {},
    runState: fixture.runState,
    runStatePath: fixture.runStatePath,
    object: manifestObject,
    verifiedBodyCache: cache,
    adapters: { getObject: async () => { throw new Error("fresh GET must not run"); } },
  });
  assert.equal(manifestObject.entry.live_observation_content_verified_against_source, true);
  assert.equal(manifestObject.entry.proposed_manifest_matches_live_observation, true);
  assert.equal(manifestObject.entry.live_observation_body_sources[0].source, "verified_get_cache");
  assert.equal(cache.snapshot().current_entries, 0);
});

test("publication order and dependencies prevent indexes preceding manifests", async () => {
  const keys = [
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/observations/day_utc=2026-06-17/connector_id=1/manifest.json",
    "history/_index_v2/observations_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/part-00000.parquet",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-17/connector_id=1/manifest.json",
    "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-06-17/connector_id=1/pollutant_code=pm25/manifest.json",
  ];
  assert.deepEqual(keys.map(publicationRank), [10, 20, 30, 40, 50, 60, 70, 80]);
  const manifestKey = keys[1];
  const indexObject = { key: keys[3], entry: { dependencies: [manifestKey] } };
  const runState = { objects: { [manifestKey]: { proposed: true, structurally_validated: true, r2_verified: false } } };
  assert.throws(
    () => assertPublicationDependenciesVerified({ object: indexObject, runState }),
    /Publication dependency is not GET-verified/,
  );
  runState.objects[manifestKey].r2_verified = true;
  assert.doesNotThrow(() => assertPublicationDependenciesVerified({ object: indexObject, runState }));

  const manifestBody = Buffer.from("{}");
  const planner = createStagedObjectMap({
    r2: {},
    store: {
      getObjectIfExists: (key) => key === manifestKey
        ? { key, body: manifestBody, bytes: manifestBody.byteLength, source: "overlay", content_sha256: sha256Hex(manifestBody) }
        : null,
    },
  });
  await planner.stagedR2.proposal_sink({ key: keys[3], body: "{}", content_type: "application/json" });
  assert.deepEqual(planner.proposals.get(keys[3]).dependencies, [manifestKey]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-integrity-index-"));
  const dropbox = path.join(root, "dropbox");
  const overlay = path.join(root, "overlay");
  const childManifest = {
    manifest_hash: "b".repeat(64),
    source_row_count: 2,
    timeseries_row_counts: { "100": 2 },
    files: [{ key: keys[0], row_count: 2, bytes: 10, etag_or_hash: "c".repeat(64) }],
  };
  const childBody = Buffer.from(JSON.stringify(childManifest));
  writeObject(dropbox, manifestKey, childBody);
  const indexPayload = {
    pollutant_manifest_key: manifestKey,
    connector_pollutant_manifest_key: manifestKey,
    pollutant_manifest_hash: childManifest.manifest_hash,
    source_row_count: childManifest.source_row_count,
    timeseries_row_counts: childManifest.timeseries_row_counts,
    files: childManifest.files,
  };
  const indexPath = writeObject(overlay, keys[3], Buffer.from(JSON.stringify(indexPayload)));
  const indexState = {
    environment: "CIC-Test",
    base_dropbox_root: dropbox,
    overlay_root: overlay,
    objects: {
      [keys[3]]: stateEntry(indexPath, keys[3], [manifestKey], {
        [manifestKey]: { sha256: sha256Hex(childBody), bytes: childBody.byteLength, source: "dropbox" },
      }),
    },
    tombstone_prefixes: [],
  };
  await assert.doesNotReject(validateFinalProposalGraph({
    runState: indexState,
    proposal: validateLocalProposal(indexState),
  }));
  indexPayload.source_row_count += 1;
  fs.writeFileSync(indexPath, JSON.stringify(indexPayload));
  indexState.objects[keys[3]] = stateEntry(indexPath, keys[3], [manifestKey], {
    [manifestKey]: { sha256: sha256Hex(childBody), bytes: childBody.byteLength, source: "dropbox" },
  });
  await assert.rejects(validateFinalProposalGraph({
    runState: indexState,
    proposal: validateLocalProposal(indexState),
  }), /manifest_counts/);
});

test("verified GET cache requires exact key and SHA, invalidates on mutation, and stays bounded to its scope", () => {
  const cache = createVerifiedGetBodyCache({ maxBytes: 8, maxEntries: 2 });
  const first = Buffer.from("1234");
  const second = Buffer.from("5678");
  const third = Buffer.from("abcd");
  const firstSha = sha256Hex(first);
  assert.equal(cache.store({ key: "history/v2/observations/a.parquet", sha256: firstSha, body: first }), true);
  assert.equal(cache.get("history/v2/observations/a.parquet", firstSha), first);
  assert.equal(cache.get("history/v2/observations/b.parquet", firstSha), null);
  assert.equal(cache.get("history/v2/observations/a.parquet", "f".repeat(64)), null);
  cache.invalidateKey("history/v2/observations/a.parquet", "later_put_same_key");
  assert.equal(cache.get("history/v2/observations/a.parquet", firstSha), null);
  cache.store({ key: "history/v2/observations/b.parquet", sha256: sha256Hex(second), body: second });
  cache.store({ key: "history/v2/observations/c.parquet", sha256: sha256Hex(third), body: third });
  cache.store({ key: "history/v2/observations/d.parquet", sha256: sha256Hex(first), body: first });
  const bounded = cache.snapshot();
  assert.ok(bounded.current_bytes <= bounded.max_bytes);
  assert.ok(bounded.current_entries <= bounded.max_entries);
  assert.ok(bounded.peak_bytes <= bounded.max_bytes);
  assert.ok(bounded.peak_entries <= bounded.max_entries);
  cache.clear("connector_day_scope_complete");
  assert.equal(cache.snapshot().current_entries, 0);
  assert.equal(cache.snapshot().current_bytes, 0);
});
