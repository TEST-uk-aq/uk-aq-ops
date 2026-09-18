import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCurrentRunManifestWriterGitSha,
  assertFixedV3Proposal,
  reconcileReconstructedExactV3Hierarchies,
  resolveExactV3LocalReferences,
  resolveIntegrityTargetWriterGitSha,
} from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  buildObservationHistoryExactLeafIndexV3Latest,
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
} from "../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  readCanonicalObservationRows,
} from "../uk_aq_apply_integrity_proposal.mjs";
import {
  inspectObservationParquetFile,
} from "../lib/uk_aq_observation_parquet_content_hash.mjs";
import {
  computeObservationContentHash,
  selectObservationVerificationStatusColumn,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
} from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

function proposalWithDependency(dependency) {
  return {
    planning: {
      proposals: [{
        key: "history/_index_v3/observations_timeseries_latest.json",
        dependencies: [dependency],
        dependency_identities: {
          [dependency]: { source: "dropbox", sha256: "a".repeat(64), bytes: 1 },
        },
      }],
    },
  };
}

test("fixed-v3 namespace guard accepts only generation-v3 observation authorities", () => {
  assert.doesNotThrow(() => assertFixedV3Proposal(proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/connector_id=1/manifest.json",
  )));
});

test("fixed-v3 namespace guard rejects v2 and unrelated dependency namespaces", () => {
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency(
      "history/v2/observations/day_utc=2026-06-01/manifest.json",
    )),
    /outside v3/,
  );
  assert.throws(
    () => assertFixedV3Proposal(proposalWithDependency("history/unrelated/object.json")),
    /outside v3 observation_index/,
  );
});

test("fixed-v3 namespace guard requires an exact dependency identity map", () => {
  const output = proposalWithDependency(
    "history/v3/observations/day_utc=2026-06-01/manifest.json",
  );
  output.planning.proposals[0].dependency_identities = {};
  assert.throws(() => assertFixedV3Proposal(output), /identities are not exact/);
});

test("canonical v3 vstatus survives Parquet decoding", async () => {
  const rows = ["P", "R"].map((verificationStatus, index) => ({
    connector_id: 1,
    station_id: 10,
    timeseries_id: 100,
    pollutant_code: "pm25",
    observed_at_utc: `2026-06-01T0${index}:00:00.000Z`,
    value: 12.5 + index,
    verification_status: verificationStatus,
  }));
  const v3 = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows,
    scope: { day_utc: "2026-06-01", connector_id: 1, pollutant_code: "pm25" },
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
  });
  const decodedV3 = (await Promise.all(v3.file_intents.map(({ body }) =>
    readCanonicalObservationRows({ body, connectorId: 1 })
  ))).flat();
  assert.deepEqual(decodedV3.map(({ verification_status }) => verification_status), ["P", "R"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-vstatus-decoders-"));
  try {
    const inspectedRows = [];
    for (const [index, intent] of v3.file_intents.entries()) {
      const filePath = path.join(root, `part-${index}.parquet`);
      fs.writeFileSync(filePath, intent.body);
      const inspected = await inspectObservationParquetFile({ filePath, connectorId: 1 });
      inspectedRows.push(...inspected.canonicalRows);
    }
    assert.deepEqual(
      inspectedRows.map(({ verification_status }) => verification_status),
      ["P", "R"],
    );
    assert.equal(
      computeObservationContentHash(inspectedRows).observation_content_hash,
      computeObservationContentHash(decodedV3).observation_content_hash,
    );
    assert.deepEqual(
      computeObservationContentHash(inspectedRows).verification_status_counts,
      computeObservationContentHash(decodedV3).verification_status_counts,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("status-column selection prefers vstatus and retains legacy names", () => {
  assert.equal(selectObservationVerificationStatusColumn(
    new Set(["status", "verification_status", "vstatus"]),
  ), "vstatus");
  assert.equal(selectObservationVerificationStatusColumn(
    new Set(["status", "verification_status"]),
  ), "verification_status");
  assert.equal(selectObservationVerificationStatusColumn(new Set(["status"])), "status");
  assert.equal(selectObservationVerificationStatusColumn(new Set()), null);
});


test("fixed-v3 staged manifests must match pinned writer provenance", () => {
  const pinned = "c".repeat(40);
  assert.equal(
    resolveIntegrityTargetWriterGitSha({
      UK_AQ_INTEGRITY_TARGET_WRITER_GIT_SHA: pinned,
    }),
    pinned,
  );
  assert.equal(
    assertCurrentRunManifestWriterGitSha({ writer_git_sha: pinned }, pinned, "manifest.json"),
    pinned,
  );
  for (const writer_git_sha of [null, "C".repeat(40), "c".repeat(39)]) {
    assert.throws(
      () => assertCurrentRunManifestWriterGitSha(
        { writer_git_sha }, pinned, "manifest.json",
      ),
      /writer_git_sha is invalid/,
    );
  }
  assert.throws(
    () => assertCurrentRunManifestWriterGitSha(
      { writer_git_sha: "d".repeat(40) }, pinned, "manifest.json",
    ),
    /contradicts pinned run/,
  );
});

test("changed exact hierarchy resolves unchanged canonical inputs only from pinned Dropbox", () => {
  const parquetKey = "history/v3/observations/day_utc=2026-06-04/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const manifestKey = "history/v3/observations/day_utc=2026-06-04/connector_id=1/pollutant_code=no2/manifest.json";
  const parquet = Buffer.from("canonical-parquet");
  const manifest = Buffer.from("canonical-manifest");
  const reference = (key, body) => ({
    key, byte_size: body.byteLength, sha256: sha256Hex(body),
  });
  const requested = [];
  const resolved = resolveExactV3LocalReferences({
    artifacts: [{
      dependencies: [reference(parquetKey, parquet)],
      publication_prerequisites: [reference(manifestKey, manifest)],
    }],
    changedKeys: new Set(),
    proposalsByKey: new Map(),
    unchangedRoots: [],
    store: {
      getObjectFromSourceIfExists(key, source) {
        requested.push([key, source]);
        const body = key === parquetKey ? parquet : key === manifestKey ? manifest : null;
        return body ? { key, body, bytes: body.byteLength, content_sha256: sha256Hex(body), source } : null;
      },
    },
  });
  assert.deepEqual(requested, [[parquetKey, "dropbox"], [manifestKey, "dropbox"]]);
  assert.deepEqual([...resolved.keys()], [parquetKey, manifestKey]);
});

function exactHierarchy(dayUtc, timeseriesId) {
  const built = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows: [{
      connector_id: 1,
      station_id: 10,
      timeseries_id: timeseriesId,
      pollutant_code: "no2",
      observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      value: 12.5,
      verification_status: "P",
    }],
    scope: { day_utc: dayUtc, connector_id: 1, pollutant_code: "no2" },
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-06-10T00:00:00.000Z",
  });
  const manifest = built.canonical_pollutant_manifest;
  return buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: built.target_metadata,
    canonicalManifest: {
      key: manifest.key,
      byte_size: manifest.byte_size,
      sha256: manifest.sha256,
      manifest_hash: manifest.payload.manifest_hash,
      row_count: manifest.payload.row_count,
      observation_content_hash: manifest.payload.observation_content_hash,
    },
  });
}

test("reconstructed exact-v3 state republishes changed roots and drops absent old scopes", () => {
  const unchanged = exactHierarchy("2026-06-01", 101);
  const changedUnselected = exactHierarchy("2026-06-02", 102);
  const absent = exactHierarchy("2026-06-03", 103);
  const builtOldLatest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [unchanged, changedUnselected, absent],
  });
  const oldLatest = {
    ...builtOldLatest,
    payload: structuredClone(builtOldLatest.payload),
  };
  const changedRoot = oldLatest.payload.day_summaries
    .flatMap(({ scoped_roots }) => scoped_roots)
    .find(({ day_utc }) => day_utc === "2026-06-02");
  changedRoot.sha256 = "f".repeat(64);

  const reconciled = reconcileReconstructedExactV3Hierarchies({
    existingLatest: oldLatest,
    hierarchies: [unchanged, changedUnselected],
  });
  assert.deepEqual(
    reconciled.changedHierarchies.map(({ scoped_manifest }) => scoped_manifest.key),
    [changedUnselected.scoped_manifest.key],
    "an unselected reconstructed mismatch must publish its complete hierarchy",
  );
  assert.deepEqual(
    reconciled.unchangedRoots.map(({ key }) => key),
    [unchanged.scoped_manifest.key],
    "a genuinely unchanged reconstructed root need not be republished",
  );
  const desiredRoots = reconciled.latest.payload.day_summaries
    .flatMap(({ scoped_roots }) => scoped_roots);
  assert.deepEqual(
    desiredRoots.map(({ key }) => key),
    [unchanged.scoped_manifest.key, changedUnselected.scoped_manifest.key],
    "from-scratch latest must not retain a scope absent from canonical reconstruction",
  );
  assert.equal(
    desiredRoots.find(({ key }) => key === changedUnselected.scoped_manifest.key).sha256,
    changedUnselected.scoped_manifest.sha256,
  );
  assert.deepEqual(reconciled.removedScopes, [{
    day_utc: "2026-06-03",
    connector_id: 1,
    pollutant_code: "no2",
    exact_prefix: "history/_index_v3/observations_timeseries/day_utc=2026-06-03/connector_id=1/pollutant_code=no2",
    aligned_prefix: "history/_index_v3/observations_timeseries/_aligned/day_utc=2026-06-03/connector_id=1/pollutant_code=no2",
  }]);
});
