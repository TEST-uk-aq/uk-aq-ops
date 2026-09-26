import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";

import {
  assertCurrentRunParquetIdentities,
  assertCurrentRunManifestWriterGitSha,
  assertFixedV3Proposal,
  authenticateExactV3CompactLatest,
  buildExactV3HierarchyForCatalogueEntry,
  buildExactV3ProposalDependencyFields,
  buildExactV3ManifestCatalogue,
  crossCheckExactV3RegistryCatalogue,
  deriveExactV3ManifestDelta,
  inspectPinnedBaselinePollutantPartition,
  reconcileReconstructedExactV3Hierarchies,
  reconstructCanonicalObservationAggregateHierarchy,
  resolveExactV3PlanningAuthority,
  resolveExactV3LocalReferences,
  resolveIntegrityTargetWriterGitSha,
} from "../uk_aq_plan_sos_light_v3_observation_metadata.mjs";
import { sha256Hex } from "../../../workers/shared/r2_sigv4.mjs";
import {
  buildObservationHistoryExactLeafIndexV3Latest,
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  encodeObservationHistoryIndexV3Json,
  updateObservationHistoryExactLeafIndexV3Latest,
  validateObservationHistoryExactLeafIndexV3LatestRegistry,
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
import { parquetMetadataAsync, parquetSchema } from "../lib/uk_aq_parquet_dependencies.mjs";
import {
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
} from "../../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";

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

test("canonical v3 P, R, and historical null survive lossless decoding", async () => {
  const rows = [null, "P", "R"].map((verificationStatus, index) => ({
    connector_id: 1,
    station_id: 10,
    timeseries_id: 100,
    pollutant_code: "no2",
    observed_at_utc: `2026-06-04T0${index}:00:00.000Z`,
    value: 12.5 + index,
    verification_status: verificationStatus,
  }));
  const v3 = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows,
    scope: { day_utc: "2026-06-04", connector_id: 1, pollutant_code: "no2" },
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
  });
  const firstBody = v3.file_intents[0].body;
  const metadata = await parquetMetadataAsync(firstBody.buffer.slice(
    firstBody.byteOffset, firstBody.byteOffset + firstBody.byteLength,
  ));
  assert.deepEqual(parquetSchema(metadata).children.map((column) =>
    String(column.element.name)
  ), ["connector_id", "station_id", "timeseries_id", "pollutant_code",
    "observed_at_utc", "value", "verification_status"]);
  assert.deepEqual(v3.canonical_pollutant_manifest.payload.columns,
    ["connector_id", "station_id", "timeseries_id", "pollutant_code",
      "observed_at_utc", "value", "verification_status"]);
  const decodedV3 = (await Promise.all(v3.file_intents.map(({ body }) =>
    readCanonicalObservationRows({ body, connectorId: 1 })
  ))).flat();
  assert.deepEqual(decodedV3.map(({ verification_status }) => verification_status), [null, "P", "R"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-verification-status-decoders-"));
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
      [null, "P", "R"],
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

test("status-column selection rejects competing names and retains legacy reads", () => {
  assert.throws(() => selectObservationVerificationStatusColumn(
    new Set(["status", "verification_status"]),
  ), /competing.*status/i);
  assert.equal(selectObservationVerificationStatusColumn(new Set(["verification_status"])), "verification_status");
  assert.equal(selectObservationVerificationStatusColumn(new Set(["status"])), "status");
  assert.equal(selectObservationVerificationStatusColumn(new Set()), null);
});

test("physical status compatibility normalises current, historical, and absent columns", async () => {
  // Initialise the same local Parquet runtime used by the production writer.
  buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows: [{ connector_id: 1, station_id: 10, timeseries_id: 100,
      pollutant_code: "pm25", observed_at_utc: "2026-06-01T00:00:00.000Z",
      value: 12.5, verification_status: "R" }],
    targetWriterGitSha: "a".repeat(40),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-status-compat-"));
  try {
    for (const [physicalName, expected] of [["verification_status", "R"], ["status", "R"], [null, null], ["both", null]]) {
      const columns = {
        connector_id: arrow.vectorFromArray([1], new arrow.Int32()),
        station_id: arrow.vectorFromArray([10], new arrow.Int32()),
        timeseries_id: arrow.vectorFromArray([100], new arrow.Int32()),
        pollutant_code: arrow.vectorFromArray(["pm25"], new arrow.Utf8()),
        observed_at_utc: arrow.vectorFromArray([new Date("2026-06-01T00:00:00.000Z")], new arrow.TimestampMillisecond()),
        value: arrow.vectorFromArray([12.5], new arrow.Float64()),
        ...(physicalName === "both"
          ? { verification_status: arrow.vectorFromArray(["R"], new arrow.Utf8()),
            status: arrow.vectorFromArray(["P"], new arrow.Utf8()) }
          : physicalName ? { [physicalName]: arrow.vectorFromArray(["R"], new arrow.Utf8()) } : {}),
      };
      const table = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(arrow.tableFromArrays(columns), "stream"));
      const body = Buffer.from(parquetWasm.writeParquet(table, new parquetWasm.WriterPropertiesBuilder().build()));
      const filePath = path.join(root, `${physicalName ?? "absent"}.parquet`);
      fs.writeFileSync(filePath, body);
      if (physicalName === "both") {
        await assert.rejects(() => readCanonicalObservationRows({ body, connectorId: 1 }), /unsupported.*columns/i);
        await assert.rejects(() => inspectObservationParquetFile({ filePath, connectorId: 1 }), /unsupported.*columns/i);
        continue;
      }
      const decoded = await readCanonicalObservationRows({ body, connectorId: 1 });
      assert.deepEqual(decoded.map((row) => row.verification_status), [expected]);
      assert.deepEqual(Object.keys(decoded[0]), ["connector_id", "station_id", "timeseries_id", "pollutant_code", "observed_at_utc", "value", "verification_status"]);
      const backupRead = await inspectObservationParquetFile({ filePath, connectorId: 1 });
      assert.deepEqual(backupRead.canonicalRows.map((row) => row.verification_status), [expected]);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rehashManifest(payload) {
  const copy = structuredClone(payload);
  delete copy.manifest_hash;
  return { ...copy, manifest_hash: sha256Hex(JSON.stringify(copy)) };
}

test("pinned fixed-v3 inspection authenticates actual bodies without reserialising them", async () => {
  const scope = {
    day_utc: "2026-08-02",
    connector_id: 1,
    pollutant_code: "no2",
  };
  const built = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows: [null, "P", "R"].map((verificationStatus, index) => ({
      connector_id: 1,
      station_id: 10,
      timeseries_id: 100,
      pollutant_code: "no2",
      observed_at_utc: `2026-08-02T0${index}:00:00.000Z`,
      value: 12.5 + index,
      verification_status: verificationStatus,
    })),
    scope,
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-08-07T02:31:56.906Z",
  });
  const manifestArtifact = built.canonical_pollutant_manifest;
  const objects = new Map(built.file_intents.map((intent) => [intent.key, {
    key: intent.key,
    body: intent.body,
    source: "dropbox",
  }]));
  const inspect = (manifest = manifestArtifact.payload, body = manifestArtifact.body,
    getPinnedObject = (key) => objects.get(key)) =>
    inspectPinnedBaselinePollutantPartition({
      manifest,
      manifestKey: manifestArtifact.key,
      manifestObject: { key: manifestArtifact.key, body, source: "dropbox" },
      scope,
      getPinnedObject,
    });

  const inspected = await inspect();
  assert.equal(
    inspected.target_metadata.observation_content_hash,
    manifestArtifact.payload.observation_content_hash,
  );
  assert.deepEqual(inspected.target_metadata.verification_status_counts, {
    P: 1,
    R: 1,
    null: 1,
  });
  assert.deepEqual(
    inspected.target_metadata.files.map(({ sha256 }) => sha256),
    built.file_intents.map(({ sha256 }) => sha256),
  );

  const firstIntent = built.file_intents[0];
  await assert.rejects(() => inspect(
    manifestArtifact.payload,
    manifestArtifact.body,
    (key) => key === firstIntent.key
      ? { key, body: Buffer.concat([firstIntent.body, Buffer.from([0])]), source: "dropbox" }
      : objects.get(key),
  ), /pinned canonical Parquet identity disagrees/);

  const falseContentHash = rehashManifest({
    ...manifestArtifact.payload,
    observation_content_hash: "f".repeat(64),
  });
  await assert.rejects(() => inspect(
    falseContentHash,
    Buffer.from(JSON.stringify(falseContentHash)),
  ), /observation_content_hash disagrees/);

  const unsupportedWriterBody = Buffer.from(firstIntent.body);
  const createdByMarker = unsupportedWriterBody.indexOf("writer_version=");
  assert.ok(createdByMarker >= 0, "fixture has a created_by writer marker");
  unsupportedWriterBody[createdByMarker] = "W".charCodeAt(0);
  const unsupportedWriterManifest = structuredClone(manifestArtifact.payload);
  unsupportedWriterManifest.files[0].etag_or_hash = sha256Hex(unsupportedWriterBody);
  const rehashedUnsupportedWriterManifest = rehashManifest(unsupportedWriterManifest);
  await assert.rejects(() => inspect(
    rehashedUnsupportedWriterManifest,
    Buffer.from(JSON.stringify(rehashedUnsupportedWriterManifest)),
    (key) => key === firstIntent.key
      ? { key, body: unsupportedWriterBody, source: "dropbox" }
      : objects.get(key),
  ), /footer writer identity mismatch/);
});

test("current-run fixed-v3 Parquet retains exact staged byte identity", () => {
  const built = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows: [{
      connector_id: 1,
      station_id: 10,
      timeseries_id: 100,
      pollutant_code: "pm25",
      observed_at_utc: "2026-06-01T00:00:00.000Z",
      value: 12.5,
      verification_status: "P",
    }],
    scope: { day_utc: "2026-06-01", connector_id: 1, pollutant_code: "pm25" },
    targetWriterGitSha: "a".repeat(40),
  });
  const objects = new Map(built.file_intents.map((intent) => [intent.key, {
    key: intent.key,
    body: intent.body,
    source: "planned_overlay",
  }]));
  assert.doesNotThrow(() => assertCurrentRunParquetIdentities(
    built.file_intents,
    (key) => objects.get(key),
  ));
  const first = built.file_intents[0];
  assert.throws(() => assertCurrentRunParquetIdentities(
    built.file_intents,
    (key) => key === first.key
      ? { key, body: Buffer.concat([first.body, Buffer.from([0])]), source: "planned_overlay" }
      : objects.get(key),
  ), /staged Parquet identity disagrees/);
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

test("changed exact hierarchy resolves a frozen new current-run canonical object absent from Dropbox", () => {
  const key = "history/v3/observations/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const body = Buffer.from("new-current-run-parquet");
  const identity = {
    key,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
  };
  const requested = [];
  const resolved = resolveExactV3LocalReferences({
    artifacts: [{ dependencies: [identity], publication_prerequisites: [] }],
    changedKeys: new Set(),
    proposalsByKey: new Map(),
    runState: {
      objects: {
        [key]: {
          stage: "observations_data",
          proposed: true,
          built: true,
          structurally_validated: true,
          changed: true,
          included_in_write_set: true,
          status: "planned",
          sha256: identity.sha256,
          bytes: identity.byte_size,
        },
      },
    },
    unchangedRoots: [],
    store: {
      getObjectFromSourceIfExists(requestedKey, source) {
        requested.push([requestedKey, source]);
        return requestedKey === key && source === "overlay"
          ? { key, body, bytes: body.byteLength, content_sha256: sha256Hex(body), source: "planned_overlay" }
          : null;
      },
    },
  });
  assert.deepEqual(requested, [[key, "overlay"]]);
  assert.deepEqual(resolved.get(key), {
    key,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
    verified: true,
    durable: true,
  });
});

test("new implicit source-derived Parquet is a planned-overlay proposal dependency", () => {
  const key = "history/v3/observations/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const body = Buffer.from("new-current-run-parquet");
  const reference = {
    key,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
  };
  const store = {
    getObjectFromSourceIfExists(requestedKey, source) {
      return requestedKey === key && source === "overlay"
        ? {
          key,
          body,
          bytes: body.byteLength,
          content_sha256: reference.sha256,
          source: "planned_overlay",
        }
        : null;
    },
    getObjectIfExists(requestedKey) {
      return requestedKey === key
        ? {
          key,
          body,
          bytes: body.byteLength,
          content_sha256: reference.sha256,
          source: "planned_overlay",
        }
        : null;
    },
  };
  const fields = buildExactV3ProposalDependencyFields({
    entry: {
      dependencies: [reference],
      publication_prerequisites: [],
      external_dependencies: [key],
      external_publication_prerequisites: [],
    },
    changedExactKeys: new Set(),
    exactByKey: new Map(),
    proposalsByKey: new Map(),
    canonicalFinalizationPrerequisiteKeys: new Set(),
    runState: {
      objects: {
        [key]: {
          stage: "observations_data",
          proposed: true,
          built: true,
          structurally_validated: true,
          changed: true,
          included_in_write_set: true,
          status: "planned",
          sha256: reference.sha256,
          bytes: reference.byte_size,
        },
      },
    },
    store,
    resolvedLocalReferences: new Map([[key, {
      key,
      byte_size: reference.byte_size,
      sha256: reference.sha256,
      verified: true,
      durable: true,
    }]]),
  });

  assert.deepEqual(fields.dependencies, [key]);
  assert.deepEqual(fields.dependency_identities[key], {
    source: "planned_overlay",
    sha256: reference.sha256,
    bytes: reference.byte_size,
  });
  assert.deepEqual(fields.pinned_baseline_references, {});
});

test("Dropbox-owned overlay copy remains a pinned proposal reference", () => {
  const key = "history/v3/observations/day_utc=2025-01-01/connector_id=8/pollutant_code=bc/part-00000.parquet";
  const body = Buffer.from("preserved-dropbox-parquet");
  const reference = {
    key,
    byte_size: body.byteLength,
    sha256: sha256Hex(body),
  };
  const fields = buildExactV3ProposalDependencyFields({
    entry: {
      dependencies: [reference],
      publication_prerequisites: [],
      external_dependencies: [key],
      external_publication_prerequisites: [],
    },
    changedExactKeys: new Set(),
    exactByKey: new Map(),
    proposalsByKey: new Map(),
    canonicalFinalizationPrerequisiteKeys: new Set(),
    runState: {
      objects: {
        [key]: {
          stage: "observations_data",
          proposal_owner: "dropbox_day_baseline",
          proposed: true,
          built: true,
          structurally_validated: true,
          sha256: reference.sha256,
          bytes: reference.byte_size,
        },
      },
    },
    store: {
      getObjectFromSourceIfExists(requestedKey, source) {
        return requestedKey === key && source === "overlay"
          ? {
            key,
            body,
            bytes: body.byteLength,
            content_sha256: reference.sha256,
            source: "planned_overlay",
          }
          : null;
      },
    },
    resolvedLocalReferences: new Map([[key, {
      key,
      byte_size: reference.byte_size,
      sha256: reference.sha256,
      verified: true,
      durable: true,
    }]]),
  });

  assert.deepEqual(fields.dependencies, []);
  assert.deepEqual(fields.dependency_identities, {});
  assert.deepEqual(fields.pinned_baseline_references[key], {
    source: "pinned_dropbox_canonical_baseline",
    sha256: reference.sha256,
    bytes: reference.byte_size,
  });
});

test("changed exact hierarchy still rejects a preserved dependency absent from Dropbox", () => {
  const key = "history/v3/observations/day_utc=2025-01-01/connector_id=8/pollutant_code=bc/part-00000.parquet";
  const body = Buffer.from("preserved-dropbox-parquet");
  assert.throws(() => resolveExactV3LocalReferences({
    artifacts: [{
      dependencies: [{ key, byte_size: 12, sha256: "a".repeat(64) }],
      publication_prerequisites: [],
    }],
    changedKeys: new Set(),
    proposalsByKey: new Map(),
    runState: {
      objects: {
        [key]: {
          stage: "observations_data",
          proposal_owner: "dropbox_day_baseline",
          proposed: true,
          built: true,
          structurally_validated: true,
          sha256: sha256Hex(body),
          bytes: body.byteLength,
        },
      },
    },
    unchangedRoots: [],
    store: {
      getObjectFromSourceIfExists(requestedKey, source) {
        return requestedKey === key && source === "overlay"
          ? {
            key,
            body,
            bytes: body.byteLength,
            content_sha256: sha256Hex(body),
            source: "planned_overlay",
          }
          : null;
      },
    },
  }), /pinned canonical baseline dependency is unavailable/);
});

test("changed exact hierarchy rejects unvalidated or identity-mismatched current-run objects", () => {
  const key = "history/v3/observations/day_utc=2025-01-01/connector_id=1/pollutant_code=no2/part-00000.parquet";
  const body = Buffer.from("new-current-run-parquet");
  const reference = { key, byte_size: body.byteLength, sha256: sha256Hex(body) };
  const baseEntry = {
    stage: "observations_data",
    proposed: true,
    built: true,
    structurally_validated: true,
    changed: true,
    included_in_write_set: true,
    status: "planned",
    sha256: reference.sha256,
    bytes: reference.byte_size,
  };
  const resolve = (entry) => resolveExactV3LocalReferences({
    artifacts: [{ dependencies: [reference], publication_prerequisites: [] }],
    changedKeys: new Set(),
    proposalsByKey: new Map(),
    runState: { objects: { [key]: entry } },
    unchangedRoots: [],
    store: {
      getObjectFromSourceIfExists(requestedKey, source) {
        return requestedKey === key && source === "overlay"
          ? { key, body, bytes: body.byteLength, content_sha256: sha256Hex(body), source: "planned_overlay" }
          : null;
      },
    },
  });
  assert.throws(
    () => resolve({ ...baseEntry, structurally_validated: false }),
    /pinned canonical baseline dependency is unavailable/,
  );
  assert.throws(
    () => resolve({ ...baseEntry, sha256: "f".repeat(64) }),
    /current-run canonical dependency identity disagrees/,
  );
});

function dayManifest(dayUtc, marker) {
  const manifestKey = `history/v3/observations/day_utc=${dayUtc}/manifest.json`;
  const payload = {
    history_version: "v2",
    manifest_kind: "day",
    domain: "observations",
    day_utc: dayUtc,
    manifest_key: manifestKey,
    source_row_count: 0,
    row_count: 0,
    file_count: 0,
    total_bytes: 0,
    files: [],
    marker,
  };
  return { ...payload, manifest_hash: sha256Hex(JSON.stringify(payload)) };
}

function selectedDayProposal(dayUtc, marker) {
  const day = dayManifest(dayUtc, marker);
  const body = JSON.stringify(day);
  return {
    key: day.manifest_key,
    proposed_body: body,
    bytes: Buffer.byteLength(body),
    new_sha256: sha256Hex(body),
    changed: true,
  };
}

function pinnedHierarchyFixture() {
  const prefix = "history/v3/observations";
  const bodies = new Map();
  const put = (key, body) => bodies.set(key, Buffer.from(body));
  const days = [
    dayManifest("2026-06-01", "old-selected"),
    dayManifest("2026-06-02", "preserved-sibling"),
    dayManifest("2026-07-01", "unaffected-month"),
    dayManifest("2025-12-31", "unaffected-year"),
  ];
  for (const day of days) put(day.manifest_key, JSON.stringify(day));
  const months = [
    buildR2HistoryV2ObservationsMonthManifest({
      basePrefix: prefix, year: "2026", month: "06", dayManifests: days.slice(0, 2),
    }),
    buildR2HistoryV2ObservationsMonthManifest({
      basePrefix: prefix, year: "2026", month: "07", dayManifests: [days[2]],
    }),
    buildR2HistoryV2ObservationsMonthManifest({
      basePrefix: prefix, year: "2025", month: "12", dayManifests: [days[3]],
    }),
  ];
  for (const month of months) {
    const key = buildR2HistoryV2ObservationsMonthManifestKey(
      prefix, month.year, month.month,
    );
    put(key, serializeR2HistoryV2ObservationsAggregateManifest(month, { basePrefix: prefix }));
  }
  const years = [
    buildR2HistoryV2ObservationsYearManifest({
      basePrefix: prefix, year: "2025", monthManifests: [months[2]],
    }),
    buildR2HistoryV2ObservationsYearManifest({
      basePrefix: prefix, year: "2026", monthManifests: months.slice(0, 2),
    }),
  ];
  for (const year of years) {
    const key = buildR2HistoryV2ObservationsYearManifestKey(prefix, year.year);
    put(key, serializeR2HistoryV2ObservationsAggregateManifest(year, { basePrefix: prefix }));
  }
  const root = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: prefix, yearManifests: years,
  });
  put(
    buildR2HistoryV2ObservationsRootManifestKey(prefix),
    serializeR2HistoryV2ObservationsAggregateManifest(root, { basePrefix: prefix }),
  );
  return { bodies, days };
}

test("fixed-v3 aggregate reconstruction follows pinned memberships and overlays selected days", () => {
  const { bodies } = pinnedHierarchyFixture();
  const selectedDay = dayManifest("2026-06-01", "repaired-selected");
  const selectedBody = JSON.stringify(selectedDay);
  const selectedKey = selectedDay.manifest_key;
  const selectedProposal = {
    key: selectedKey,
    proposed_body: selectedBody,
    bytes: Buffer.byteLength(selectedBody),
    new_sha256: sha256Hex(selectedBody),
    changed: true,
  };
  const proposals = [selectedProposal];
  const proposalsByKey = new Map([[selectedKey, selectedProposal]]);
  const reads = [];
  const store = {
    getObjectFromSourceIfExists(key, source) {
      reads.push([key, source]);
      const body = bodies.get(key);
      return body ? {
        key, body, bytes: body.byteLength, content_sha256: sha256Hex(body), source,
      } : null;
    },
  };
  const rebuilt = reconstructCanonicalObservationAggregateHierarchy({
    proposals,
    proposalsByKey,
    selectedDays: ["2026-06-01"],
    store,
  });
  assert.deepEqual(rebuilt.staged_keys, [
    "history/v3/observations/_manifests/manifest.json",
    "history/v3/observations/_manifests/year=2026/manifest.json",
    "history/v3/observations/_manifests/year=2026/month=06/manifest.json",
  ]);
  assert.deepEqual(
    proposalsByKey.get("history/v3/observations/_manifests/year=2026/month=06/manifest.json")
      .dependencies,
    [selectedKey],
  );
  assert.deepEqual(
    proposalsByKey.get("history/v3/observations/_manifests/year=2026/manifest.json")
      .dependencies,
    ["history/v3/observations/_manifests/year=2026/month=06/manifest.json"],
  );
  assert.deepEqual(
    proposalsByKey.get("history/v3/observations/_manifests/manifest.json").dependencies,
    ["history/v3/observations/_manifests/year=2026/manifest.json"],
  );
  assert(reads.some(([key]) => key.endsWith("year=2025/manifest.json")));
  assert(reads.some(([key]) => key.endsWith("year=2026/month=07/manifest.json")));
  assert(!reads.some(([key]) => key.includes("day_utc=2026-07-01")));
  assert(!reads.some(([key]) => key.includes("day_utc=2025-12-31")));
});

test("fixed-v3 aggregate reconstruction fails when a pinned sibling body is missing", () => {
  const { bodies } = pinnedHierarchyFixture();
  bodies.delete("history/v3/observations/day_utc=2026-06-02/manifest.json");
  const selectedDay = dayManifest("2026-06-01", "repaired-selected");
  const selectedBody = JSON.stringify(selectedDay);
  const selectedProposal = {
    key: selectedDay.manifest_key,
    proposed_body: selectedBody,
    bytes: Buffer.byteLength(selectedBody),
    new_sha256: sha256Hex(selectedBody),
    changed: true,
  };
  assert.throws(() => reconstructCanonicalObservationAggregateHierarchy({
    proposals: [selectedProposal],
    proposalsByKey: new Map([[selectedDay.manifest_key, selectedProposal]]),
    selectedDays: ["2026-06-01"],
    store: {
      getObjectFromSourceIfExists(key, source) {
        const body = bodies.get(key);
        return body ? { key, body, source } : null;
      },
    },
  }), /pinned observation day manifest is unavailable/);
});

test("fixed-v3 aggregate reconstruction inserts selected new day, month, and year membership", () => {
  const { bodies } = pinnedHierarchyFixture();
  const selected = [
    selectedDayProposal("2026-06-03", "new-day"),
    selectedDayProposal("2026-08-01", "new-month"),
    selectedDayProposal("2027-01-01", "new-year"),
  ];
  const requested = [];
  const proposalsByKey = new Map(selected.map((proposal) => [proposal.key, proposal]));
  const rebuilt = reconstructCanonicalObservationAggregateHierarchy({
    proposals: selected,
    proposalsByKey,
    selectedDays: ["2026-06-03", "2026-08-01", "2027-01-01"],
    store: {
      getObjectFromSourceIfExists(key, source) {
        requested.push([key, source]);
        const body = bodies.get(key);
        return body ? { key, body, source } : null;
      },
    },
  });
  assert.deepEqual(rebuilt.staged_keys, [
    "history/v3/observations/_manifests/manifest.json",
    "history/v3/observations/_manifests/year=2026/manifest.json",
    "history/v3/observations/_manifests/year=2026/month=06/manifest.json",
    "history/v3/observations/_manifests/year=2026/month=08/manifest.json",
    "history/v3/observations/_manifests/year=2027/manifest.json",
    "history/v3/observations/_manifests/year=2027/month=01/manifest.json",
  ]);
  const june = JSON.parse(proposalsByKey.get(
    "history/v3/observations/_manifests/year=2026/month=06/manifest.json",
  ).proposed_body);
  assert.deepEqual(june.children.map(({ day_utc }) => day_utc), [
    "2026-06-01", "2026-06-02", "2026-06-03",
  ]);
  const year2026 = JSON.parse(proposalsByKey.get(
    "history/v3/observations/_manifests/year=2026/manifest.json",
  ).proposed_body);
  assert.deepEqual(year2026.children.map(({ month }) => month), ["06", "07", "08"]);
  const root = JSON.parse(proposalsByKey.get(
    "history/v3/observations/_manifests/manifest.json",
  ).proposed_body);
  assert.deepEqual(root.children.map(({ year }) => year), [2025, 2026, 2027]);
  assert.deepEqual(proposalsByKey.get(
    "history/v3/observations/_manifests/year=2027/month=01/manifest.json",
  ).dependencies, [selected[2].key]);
  assert.deepEqual(proposalsByKey.get(
    "history/v3/observations/_manifests/year=2027/manifest.json",
  ).dependencies, [
    "history/v3/observations/_manifests/year=2027/month=01/manifest.json",
  ]);
  assert.deepEqual(proposalsByKey.get(
    "history/v3/observations/_manifests/manifest.json",
  ).dependencies, [
    "history/v3/observations/_manifests/year=2026/manifest.json",
    "history/v3/observations/_manifests/year=2027/manifest.json",
  ]);
  assert(requested.some(([key, source]) =>
    key.endsWith("day_utc=2026-06-02/manifest.json") && source === "dropbox"
  ));
  assert(!requested.some(([key]) => key.includes("month=08")));
  assert(!requested.some(([key]) => key.includes("year=2027")));
});

test("fixed-v3 aggregate reconstruction rejects a referenced month with no pinned body", () => {
  const { bodies } = pinnedHierarchyFixture();
  const missingKey =
    "history/v3/observations/_manifests/year=2026/month=06/manifest.json";
  bodies.delete(missingKey);
  const selected = selectedDayProposal("2026-06-03", "new-day");
  assert.throws(() => reconstructCanonicalObservationAggregateHierarchy({
    proposals: [selected],
    proposalsByKey: new Map([[selected.key, selected]]),
    selectedDays: ["2026-06-03"],
    store: {
      getObjectFromSourceIfExists(key, source) {
        const body = bodies.get(key);
        return body ? { key, body, source } : null;
      },
    },
  }), /pinned observation month aggregate is unavailable/);
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

test("full reconstructed exact-v3 fallback republishes every scope and applies explicit removals", () => {
  const unchanged = exactHierarchy("2026-06-01", 101);
  const changedUnselected = exactHierarchy("2026-06-02", 102);
  const reconciled = reconcileReconstructedExactV3Hierarchies({
    hierarchies: [unchanged, changedUnselected],
    removedScopes: [{
      day_utc: "2026-06-03",
      connector_id: 1,
      pollutant_code: "no2",
      exact_prefix: "history/_index_v3/observations_timeseries/day_utc=2026-06-03/connector_id=1/pollutant_code=no2",
      aligned_prefix: "history/_index_v3/observations_timeseries/_aligned/day_utc=2026-06-03/connector_id=1/pollutant_code=no2",
    }],
  });
  assert.deepEqual(
    reconciled.changedHierarchies.map(({ scoped_manifest }) => scoped_manifest.key),
    [unchanged.scoped_manifest.key, changedUnselected.scoped_manifest.key],
    "fallback must publish every completely reconstructed hierarchy",
  );
  assert.deepEqual(reconciled.unchangedRoots, []);
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

function latestWithPayload(base, payload) {
  const body = encodeObservationHistoryIndexV3Json(payload);
  return {
    ...base,
    payload,
    body,
    byte_size: Buffer.byteLength(body),
    sha256: sha256Hex(body),
  };
}

test("compact latest validator rejects duplicate roots and aggregate contradictions", () => {
  const first = exactHierarchy("2026-06-01", 101);
  const second = exactHierarchy("2026-06-02", 102);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [first, second],
  });
  const validated = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest });
  assert.equal(validated.roots.length, 2);

  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: { ...latest, key: `${latest.key}.wrong` },
    }),
    /registry key/,
  );
  const nonCanonicalBody = JSON.stringify(latest.payload, null, 2);
  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: {
        ...latest,
        body: nonCanonicalBody,
        byte_size: Buffer.byteLength(nonCanonicalBody),
        sha256: sha256Hex(nonCanonicalBody),
      },
    }),
    /identity mismatch/,
  );
  const wrongVersionPayload = { ...structuredClone(latest.payload), schema_version: 2 };
  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: latestWithPayload(latest, wrongVersionPayload),
    }),
    /aggregate fields are contradictory/,
  );
  const unsortedPayload = structuredClone(latest.payload);
  unsortedPayload.day_summaries.reverse();
  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: latestWithPayload(latest, unsortedPayload),
    }),
    /aggregate fields are contradictory/,
  );

  const duplicatePayload = structuredClone(latest.payload);
  duplicatePayload.day_summaries[0].scoped_roots.push(
    structuredClone(duplicatePayload.day_summaries[0].scoped_roots[0]),
  );
  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: latestWithPayload(latest, duplicatePayload),
    }),
    /duplicate scoped root/,
  );

  const aggregatePayload = structuredClone(latest.payload);
  aggregatePayload.total_rows += 1;
  assert.throws(
    () => validateObservationHistoryExactLeafIndexV3LatestRegistry({
      artifact: latestWithPayload(latest, aggregatePayload),
    }),
    /aggregate fields are contradictory/,
  );
});

test("compact latest update handles unchanged, replacement, new, and removed scopes", () => {
  const retained = exactHierarchy("2026-06-01", 101);
  const removed = exactHierarchy("2026-06-02", 102);
  const replacement = exactHierarchy("2026-06-01", 201);
  const added = exactHierarchy("2026-06-03", 103);
  const unaffected = exactHierarchy("2026-06-04", 104);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [retained, removed, unaffected],
  });
  assert.equal(
    updateObservationHistoryExactLeafIndexV3Latest({ existingLatest: latest }).sha256,
    latest.sha256,
    "a valid no-op must preserve the compact latest identity",
  );
  const updated = updateObservationHistoryExactLeafIndexV3Latest({
    existingLatest: latest,
    replacementScopedManifests: [replacement.scoped_manifest, added.scoped_manifest],
    removedScopes: [removed.scoped_manifest.payload],
  });
  const roots = updated.payload.day_summaries.flatMap(({ scoped_roots }) => scoped_roots);
  assert.deepEqual(
    roots.map(({ day_utc }) => day_utc),
    ["2026-06-01", "2026-06-03", "2026-06-04"],
  );
  assert.equal(roots[0].sha256, replacement.scoped_manifest.sha256);
  assert.equal(roots[1].sha256, added.scoped_manifest.sha256);
  assert.equal(roots[2].sha256, unaffected.scoped_manifest.sha256);
  assert.equal(
    updated.body,
    buildObservationHistoryExactLeafIndexV3Latest({
      scopedHierarchies: [replacement, added, unaffected],
    }).body,
    "incremental latest must equal complete deterministic reconstruction",
  );
});

function cataloguePartition(dayUtc, timeseriesId, value = 12.5) {
  return buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.sosHistoricalReplacement,
    rows: [{
      connector_id: 1,
      station_id: 10,
      timeseries_id: timeseriesId,
      pollutant_code: "no2",
      observed_at_utc: `${dayUtc}T00:00:00.000Z`,
      value,
      verification_status: "P",
    }],
    scope: { day_utc: dayUtc, connector_id: 1, pollutant_code: "no2" },
    targetWriterGitSha: "a".repeat(40),
    backedUpAtUtc: "2026-06-10T00:00:00.000Z",
  });
}

test("manifest delta excludes byte-identical forced republication and selects actual changes", () => {
  const unchanged = cataloguePartition("2026-06-01", 101);
  const changed = cataloguePartition("2026-06-02", 102, 22.5);
  const added = cataloguePartition("2026-06-03", 103);
  const artifacts = [unchanged, changed, added].map((built) => built.canonical_pollutant_manifest);
  const objects = new Map(artifacts.map((artifact) => [artifact.key, {
    key: artifact.key,
    body: Buffer.from(artifact.body),
    source: "planned_overlay",
  }]));
  const catalogue = buildExactV3ManifestCatalogue({
    manifestKeys: objects.keys(),
    getObject: (key) => objects.get(key),
  });
  const removedKey = "history/v3/observations/day_utc=2026-06-04/connector_id=1/pollutant_code=no2/manifest.json";
  const baselineObjects = [
    {
      key: unchanged.canonical_pollutant_manifest.key,
      size: unchanged.canonical_pollutant_manifest.byte_size,
      content_sha256: unchanged.canonical_pollutant_manifest.sha256,
    },
    {
      key: changed.canonical_pollutant_manifest.key,
      size: changed.canonical_pollutant_manifest.byte_size,
      content_sha256: "f".repeat(64),
    },
    { key: removedKey, size: 1, content_sha256: "e".repeat(64) },
  ];
  const delta = deriveExactV3ManifestDelta({ finalCatalogue: catalogue, baselineObjects });
  assert.deepEqual(
    delta.affected_entries.map(({ key }) => key),
    [changed.canonical_pollutant_manifest.key, added.canonical_pollutant_manifest.key],
  );
  assert.deepEqual(delta.removed_scopes.map(({ day_utc }) => day_utc), ["2026-06-04"]);
});

test("authenticated registry contradiction is discarded by conservative full fallback", () => {
  const canonical = cataloguePartition("2026-06-01", 101, 12.5);
  const canonicalManifest = canonical.canonical_pollutant_manifest;
  const catalogue = buildExactV3ManifestCatalogue({
    manifestKeys: [canonicalManifest.key],
    getObject: () => ({
      key: canonicalManifest.key,
      body: Buffer.from(canonicalManifest.body),
      source: "dropbox",
    }),
  });
  const delta = deriveExactV3ManifestDelta({
    finalCatalogue: catalogue,
    baselineObjects: [{
      key: canonicalManifest.key,
      size: canonicalManifest.byte_size,
      content_sha256: canonicalManifest.sha256,
    }],
  });
  const contradictory = cataloguePartition("2026-06-02", 202, 99.5);
  const contradictoryManifest = contradictory.canonical_pollutant_manifest;
  const contradictoryHierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: contradictory.target_metadata,
    canonicalManifest: {
      key: contradictoryManifest.key,
      byte_size: contradictoryManifest.byte_size,
      sha256: contradictoryManifest.sha256,
      manifest_hash: contradictoryManifest.payload.manifest_hash,
      row_count: contradictoryManifest.payload.row_count,
      observation_content_hash: contradictoryManifest.payload.observation_content_hash,
    },
  });
  const rejectedLatest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [contradictoryHierarchy],
  });
  const dropboxReads = [];
  const authority = resolveExactV3PlanningAuthority({
    runState: { dropbox_currentness: { allowed: true, checkpoint: {
      observations_timeseries_latest: {
        key: rejectedLatest.key,
        byte_size: rejectedLatest.byte_size,
        sha256: rejectedLatest.sha256,
      },
    } } },
    store: {
      getObjectFromSourceIfExists(key, source) {
        dropboxReads.push([key, source]);
        return {
          key,
          body: Buffer.from(rejectedLatest.body),
          bytes: rejectedLatest.byte_size,
          content_sha256: rejectedLatest.sha256,
          source,
        };
      },
    },
    finalCatalogue: catalogue,
    delta,
  });
  assert.equal(authority.mode, "full_canonical_reconstruction_fallback");
  assert.equal(authority.compact_latest, null);
  assert.match(authority.fallback_reason, /missing unchanged scope/);
  assert.deepEqual(dropboxReads, [[rejectedLatest.key, "dropbox"]]);

  const canonicalHierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: canonical.target_metadata,
    canonicalManifest: {
      key: canonicalManifest.key,
      byte_size: canonicalManifest.byte_size,
      sha256: canonicalManifest.sha256,
      manifest_hash: canonicalManifest.payload.manifest_hash,
      row_count: canonicalManifest.payload.row_count,
      observation_content_hash: canonicalManifest.payload.observation_content_hash,
    },
  });
  const removal = {
    day_utc: "2026-05-31",
    connector_id: 1,
    pollutant_code: "no2",
    exact_prefix: "history/_index_v3/observations_timeseries/day_utc=2026-05-31/connector_id=1/pollutant_code=no2",
    aligned_prefix: "history/_index_v3/observations_timeseries/_aligned/day_utc=2026-05-31/connector_id=1/pollutant_code=no2",
  };
  const fallback = reconcileReconstructedExactV3Hierarchies({
    hierarchies: [canonicalHierarchy],
    removedScopes: [removal],
  });
  assert.deepEqual(fallback.changedHierarchies, [canonicalHierarchy]);
  assert.deepEqual(fallback.unchangedRoots, []);
  assert.deepEqual(fallback.removedScopes, [removal]);
  assert.equal(
    fallback.latest.body,
    buildObservationHistoryExactLeafIndexV3Latest({
      scopedHierarchies: [canonicalHierarchy],
    }).body,
  );
  assert.notEqual(fallback.latest.sha256, rejectedLatest.sha256);

  const exactObjects = [
    ...fallback.changedHierarchies.flatMap(({ publication_objects }) => publication_objects),
    fallback.latest,
  ];
  const changedExactKeys = new Set(exactObjects.map(({ key }) => key));
  const dependencyFields = buildExactV3ProposalDependencyFields({
    entry: {
      dependencies: fallback.latest.dependencies,
      publication_prerequisites: [],
      external_dependencies: [],
      external_publication_prerequisites: [],
    },
    changedExactKeys,
    exactByKey: new Map(exactObjects.map((artifact) => [artifact.key, artifact])),
    proposalsByKey: new Map(),
    canonicalFinalizationPrerequisiteKeys: new Set(),
    runState: { objects: {} },
    store: { getObjectFromSourceIfExists: () => null },
    resolvedLocalReferences: new Map(),
    registryRootKeys: new Set(),
  });
  assert.equal(
    Object.values(dependencyFields.pinned_baseline_references).some(
      ({ source }) => source === "pinned_checkpoint_compact_latest_registry",
    ),
    false,
  );
});

test("fallback treats a Dropbox-owned overlay manifest as pinned baseline", async () => {
  const built = cataloguePartition("2026-06-05", 105);
  const manifest = built.canonical_pollutant_manifest;
  const overlayManifest = {
    key: manifest.key,
    body: Buffer.from(manifest.body),
    source: "overlay",
  };
  const catalogue = buildExactV3ManifestCatalogue({
    manifestKeys: [manifest.key],
    getObject: () => overlayManifest,
  });
  const pinnedObjects = new Map([
    [manifest.key, { key: manifest.key, body: Buffer.from(manifest.body), source: "dropbox" }],
    ...built.file_intents.map((intent) => [intent.key, {
      key: intent.key,
      body: Buffer.from(intent.body),
      source: "dropbox",
    }]),
  ]);
  const pinnedReads = [];
  const hierarchy = await buildExactV3HierarchyForCatalogueEntry({
    entry: catalogue.entries[0],
    proposalsByKey: new Map([[manifest.key, {
      key: manifest.key,
      proposal_owner: "dropbox_day_baseline",
      changed: true,
    }]]),
    runState: { objects: { [manifest.key]: {
      stage: "observations_data",
      proposal_owner: "dropbox_day_baseline",
      proposed: true,
      built: true,
      structurally_validated: true,
      changed: true,
      included_in_write_set: true,
      status: "planned",
    } } },
    store: {
      getObjectFromSourceIfExists(key, source) {
        pinnedReads.push([key, source]);
        return source === "dropbox" ? pinnedObjects.get(key) || null : null;
      },
    },
    combinedObject: () => {
      throw new Error("preserved baseline must not use current-run overlay reconstruction");
    },
    targetWriterGitSha: "b".repeat(40),
  });
  assert.equal(hierarchy.scoped_manifest.payload.day_utc, "2026-06-05");
  assert.ok(pinnedReads.length > 1);
  assert.equal(pinnedReads.every(([, source]) => source === "dropbox"), true);

  await assert.rejects(() => buildExactV3HierarchyForCatalogueEntry({
    entry: catalogue.entries[0],
    proposalsByKey: new Map(),
    runState: { objects: { [manifest.key]: {
      stage: "observations_data",
      proposal_owner: "dropbox_day_baseline",
      proposed: true,
      built: true,
      structurally_validated: true,
    } } },
    store: { getObjectFromSourceIfExists: () => null },
    combinedObject: () => overlayManifest,
    targetWriterGitSha: "b".repeat(40),
  }), /pinned pollutant manifest is unavailable/);

  await assert.rejects(() => buildExactV3HierarchyForCatalogueEntry({
    entry: catalogue.entries[0],
    proposalsByKey: new Map([[manifest.key, {
      proposal_owner: "source_derived_observation_repair",
    }]]),
    runState: { objects: { [manifest.key]: {
      proposal_owner: "dropbox_day_baseline",
    } } },
    store: { getObjectFromSourceIfExists: () => null },
    combinedObject: () => overlayManifest,
    targetWriterGitSha: "b".repeat(40),
  }), /ownership is contradictory/);
});

test("fallback retains derived ownership for a genuine current-run manifest", async () => {
  const built = cataloguePartition("2026-06-06", 106);
  const manifest = built.canonical_pollutant_manifest;
  const objects = new Map([
    [manifest.key, { key: manifest.key, body: Buffer.from(manifest.body), source: "overlay" }],
    ...built.file_intents.map((intent) => [intent.key, {
      key: intent.key,
      body: Buffer.from(intent.body),
      source: "planned_overlay",
    }]),
  ]);
  const catalogue = buildExactV3ManifestCatalogue({
    manifestKeys: [manifest.key],
    getObject: (key) => objects.get(key),
  });
  const combinedReads = [];
  const hierarchy = await buildExactV3HierarchyForCatalogueEntry({
    entry: catalogue.entries[0],
    proposalsByKey: new Map(),
    runState: { objects: { [manifest.key]: {
      stage: "observations_data",
      proposed: true,
      built: true,
      structurally_validated: true,
      changed: true,
      included_in_write_set: true,
      status: "planned",
    } } },
    store: {
      getObjectFromSourceIfExists() {
        throw new Error("current-run source-derived manifest must not use Dropbox baseline");
      },
    },
    combinedObject(key) {
      combinedReads.push(key);
      return objects.get(key) || null;
    },
    targetWriterGitSha: "a".repeat(40),
  });
  assert.equal(hierarchy.scoped_manifest.payload.day_utc, "2026-06-06");
  assert.deepEqual(
    [...new Set(combinedReads)],
    built.file_intents.map(({ key }) => key),
  );
  assert.ok(combinedReads.length >= built.file_intents.length);
});

test("checkpoint authentication pins compact latest and registry provenance is explicit", () => {
  const hierarchy = exactHierarchy("2026-06-01", 101);
  const latest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [hierarchy],
  });
  const object = {
    key: latest.key,
    body: Buffer.from(latest.body),
    bytes: latest.byte_size,
    content_sha256: latest.sha256,
    source: "dropbox",
  };
  const authenticated = authenticateExactV3CompactLatest({
    runState: {
      dropbox_currentness: {
        allowed: true,
        checkpoint: {
          observations_timeseries_latest: {
            key: latest.key,
            byte_size: latest.byte_size,
            sha256: latest.sha256,
          },
        },
      },
    },
    store: {
      getObjectFromSourceIfExists: (key, source) =>
        key === latest.key && source === "dropbox" ? object : null,
    },
  });
  assert.equal(authenticated.artifact.sha256, latest.sha256);
  assert.throws(() => authenticateExactV3CompactLatest({
    runState: {
      dropbox_currentness: {
        allowed: true,
        checkpoint: { observations_timeseries_latest: {
          key: latest.key, byte_size: latest.byte_size, sha256: "0".repeat(64),
        } },
      },
    },
    store: { getObjectFromSourceIfExists: () => object },
  }), /identity disagrees/);

  const root = authenticated.roots[0];
  const fields = buildExactV3ProposalDependencyFields({
    entry: {
      dependencies: [root],
      publication_prerequisites: [],
      external_dependencies: [root.key],
      external_publication_prerequisites: [],
    },
    changedExactKeys: new Set(),
    exactByKey: new Map(),
    proposalsByKey: new Map(),
    canonicalFinalizationPrerequisiteKeys: new Set(),
    runState: { objects: {} },
    store: { getObjectFromSourceIfExists: () => null },
    resolvedLocalReferences: new Map([[root.key, {
      key: root.key,
      byte_size: root.byte_size,
      sha256: root.sha256,
      verified: true,
      durable: true,
    }]]),
    registryRootKeys: new Set([root.key]),
  });
  assert.equal(
    fields.pinned_baseline_references[root.key].source,
    "pinned_checkpoint_compact_latest_registry",
  );
});

test("registry catalogue cross-check rejects an unchanged summary contradiction", () => {
  const built = cataloguePartition("2026-06-01", 101);
  const artifact = built.canonical_pollutant_manifest;
  const catalogue = buildExactV3ManifestCatalogue({
    manifestKeys: [artifact.key],
    getObject: () => ({ key: artifact.key, body: Buffer.from(artifact.body), source: "dropbox" }),
  });
  const hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: built.target_metadata,
    canonicalManifest: {
      key: artifact.key,
      byte_size: artifact.byte_size,
      sha256: artifact.sha256,
      manifest_hash: artifact.payload.manifest_hash,
      row_count: artifact.payload.row_count,
      observation_content_hash: artifact.payload.observation_content_hash,
    },
  });
  const latest = buildObservationHistoryExactLeafIndexV3Latest({ scopedHierarchies: [hierarchy] });
  const registry = validateObservationHistoryExactLeafIndexV3LatestRegistry({ artifact: latest });
  const contradictory = [{ ...registry.roots[0], row_count: registry.roots[0].row_count + 1 }];
  assert.throws(() => crossCheckExactV3RegistryCatalogue({
    registryRoots: contradictory,
    finalCatalogue: catalogue,
    delta: deriveExactV3ManifestDelta({
      finalCatalogue: catalogue,
      baselineObjects: [{
        key: artifact.key, size: artifact.byte_size, content_sha256: artifact.sha256,
      }],
    }),
  }), /contradicts unchanged scope row_count/);

  const delta = deriveExactV3ManifestDelta({
    finalCatalogue: catalogue,
    baselineObjects: [{
      key: artifact.key, size: artifact.byte_size, content_sha256: artifact.sha256,
    }],
  });
  const fallback = resolveExactV3PlanningAuthority({
    runState: { dropbox_currentness: { allowed: true, checkpoint: {
      observations_timeseries_latest: {
        key: latest.key,
        byte_size: latest.byte_size,
        sha256: "0".repeat(64),
      },
    } } },
    store: { getObjectFromSourceIfExists: () => ({
      key: latest.key,
      body: Buffer.from(latest.body),
      bytes: latest.byte_size,
      content_sha256: latest.sha256,
      source: "dropbox",
    }) },
    finalCatalogue: catalogue,
    delta,
  });
  assert.equal(fallback.mode, "full_canonical_reconstruction_fallback");
  assert.equal(fallback.compact_latest, null);
  assert.match(fallback.fallback_reason, /identity disagrees/);
});
