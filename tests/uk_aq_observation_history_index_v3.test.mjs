import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildCanonicalObservationTimeseriesBoundedFiles,
} from "../workers/shared/uk_aq_observation_history_target_writer.mjs";
import {
  buildObservationHistoryIndexV3Latest,
  buildObservationHistoryIndexV3PublicationPlan,
  buildObservationHistoryIndexV3ScopedHierarchy,
  buildObservationHistoryIndexV3ScopedManifest,
  encodeObservationHistoryIndexV3Json,
  finalizeObservationHistoryIndexV3Publication,
  updateObservationHistoryIndexV3Latest,
  updateObservationHistoryIndexV3ScopedManifest,
  validateObservationHistoryIndexV3ChildShardArtifact,
  validateObservationHistoryIndexV3LatestArtifact,
  validateObservationHistoryIndexV3ScopedManifestArtifact,
  validateObservationHistoryTargetMetadataForV3,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  resolveObservationHistoryIndexV3BuildConfig,
} from "../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";

const limits = Object.freeze({
  target_row_group_rows: 4,
  max_row_group_rows: 4,
  target_file_rows: 5,
  max_file_rows: 5,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});
const LEGACY_LAYOUT = "timeseries-bounded-v1";

function asLegacyShardFixtureMetadata(metadata) {
  const segment = (value) => ({
    ...value,
    physical_layout_version: LEGACY_LAYOUT,
  });
  return {
    ...metadata,
    physical_layout_version: LEGACY_LAYOUT,
    files: metadata.files.map((file) => ({
      ...file,
      physical_layout_version: LEGACY_LAYOUT,
      row_groups: file.row_groups.map((rowGroup) => ({
        ...rowGroup,
        segments: rowGroup.segments.map(segment),
      })),
    })),
    segments: metadata.segments.map(segment),
  };
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function makeRows({
  dayUtc,
  connectorId,
  definitions,
  valueOffsetsByTimeseries = {},
}) {
  return definitions.flatMap(([timeseriesId, count], definitionIndex) =>
    Array.from({ length: count }, (_, rowIndex) => ({
      connector_id: connectorId,
      station_id: timeseriesId + 10,
      timeseries_id: timeseriesId,
      pollutant_code: "pm25",
      observed_at_utc: new Date(
        `${dayUtc}T${String(definitionIndex).padStart(2, "0")}:00:00.000Z`,
      ).toISOString().replace(
        ":00:00.000Z",
        `:${String(rowIndex).padStart(2, "0")}:00.000Z`,
      ),
      value:
        timeseriesId + rowIndex / 10 +
        Number(valueOffsetsByTimeseries[timeseriesId] || 0),
      verification_status: rowIndex % 2 ? "P" : null,
    }))
  );
}

function buildPhase1({
  dayUtc,
  connectorId,
  definitions,
  valueOffsetsByTimeseries = {},
}) {
  const rows = makeRows({
    dayUtc,
    connectorId,
    definitions,
    valueOffsetsByTimeseries,
  });
  const built = buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits,
    fileKeyForOrdinal: (ordinal) =>
      `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}` +
      `/pollutant_code=pm25/part-${String(ordinal).padStart(5, "0")}.parquet`,
  });
  return asLegacyShardFixtureMetadata(built.metadata);
}

function canonicalManifestFor(metadata) {
  const payload = {
    day_utc: metadata.partition.day_utc,
    connector_id: metadata.partition.connector_id,
    pollutant_code: metadata.partition.pollutant_code,
    row_count: metadata.row_count,
    observation_content_hash: metadata.observation_content_hash,
    file_identities: metadata.files.map((file) => [
      file.key,
      file.byte_size,
      file.sha256,
    ]),
  };
  const body = `${JSON.stringify(payload)}\n`;
  return {
    key: `history/v2/observations/day_utc=${metadata.partition.day_utc}` +
      `/connector_id=${metadata.partition.connector_id}` +
      `/pollutant_code=${metadata.partition.pollutant_code}/manifest.json`,
    byte_size: Buffer.byteLength(body),
    sha256: sha256(body),
    manifest_hash: sha256(JSON.stringify(payload)),
    row_count: metadata.row_count,
    observation_content_hash: metadata.observation_content_hash,
  };
}

function canonicalManifestPublicationObject(metadata, descriptor) {
  const payload = {
    day_utc: metadata.partition.day_utc,
    connector_id: metadata.partition.connector_id,
    pollutant_code: metadata.partition.pollutant_code,
    row_count: metadata.row_count,
    observation_content_hash: metadata.observation_content_hash,
    file_identities: metadata.files.map((file) => [
      file.key,
      file.byte_size,
      file.sha256,
    ]),
  };
  const body = `${JSON.stringify(payload)}\n`;
  assert.equal(Buffer.byteLength(body), descriptor.byte_size);
  assert.equal(sha256(body), descriptor.sha256);
  return {
    kind: "canonical_observation_manifest",
    key: descriptor.key,
    body,
    byte_size: descriptor.byte_size,
    sha256: descriptor.sha256,
    content_type: "application/json; charset=utf-8",
    publication_stage: "canonical_manifest",
    dependencies: metadata.files.map((file) => ({
      kind: "canonical_parquet",
      key: file.key,
      byte_size: file.byte_size,
      sha256: file.sha256,
    })),
    publication_prerequisites: [],
  };
}

function reorderPhase1Metadata(metadata) {
  const reordered = structuredClone(metadata);
  reordered.files.reverse();
  reordered.segments.reverse();
  for (const file of reordered.files) {
    file.row_groups.reverse();
    for (const rowGroup of file.row_groups) rowGroup.segments.reverse();
    file.timeseries_row_counts = Object.fromEntries(
      Object.entries(file.timeseries_row_counts).reverse(),
    );
  }
  return reordered;
}

function reidentifyArtifact(artifact, payload) {
  const body = encodeObservationHistoryIndexV3Json(payload);
  return {
    ...artifact,
    payload,
    body,
    byte_size: Buffer.byteLength(body),
    sha256: sha256(body),
  };
}

function externalReferencesFor(objects) {
  const changedKeys = new Set(objects.map((object) => object.key));
  const byKey = new Map();
  for (const object of objects) {
    for (const dependency of [
      ...object.dependencies,
      ...(object.publication_prerequisites || []),
    ]) {
      if (changedKeys.has(dependency.key)) continue;
      const previous = byKey.get(dependency.key);
      if (previous) {
        assert.equal(previous.byte_size, dependency.byte_size);
        assert.equal(previous.sha256, dependency.sha256);
      } else {
        byKey.set(dependency.key, {
          ...dependency,
          verified: true,
          durable: true,
        });
      }
    }
  }
  return [...byKey.values()].reverse();
}

test("v3 hierarchy is byte-stable and preserves cross-shard files and continuations", () => {
  const metadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[999, 1], [1000, 1], [1500, 7]],
  });
  const canonicalManifest = canonicalManifestFor(metadata);
  const first = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata,
    canonicalManifest,
  });
  const reordered = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: reorderPhase1Metadata(metadata),
    canonicalManifest,
  });

  assert.deepEqual(
    first.child_shards.map((artifact) => [artifact.key, artifact.body]),
    reordered.child_shards.map((artifact) => [artifact.key, artifact.body]),
  );
  assert.equal(first.scoped_manifest.body, reordered.scoped_manifest.body);
  assert.deepEqual(
    first.child_shards.map((artifact) => artifact.key.split("/").at(-1)),
    ["range=000000-000999.json", "range=001000-001999.json"],
  );

  const shard999 = first.child_shards[0].payload;
  const shard1000 = first.child_shards[1].payload;
  assert.deepEqual(
    shard999.timeseries.map((entry) => entry.timeseries_id),
    [999],
  );
  assert.deepEqual(
    shard1000.timeseries.map((entry) => entry.timeseries_id),
    [1000, 1500],
  );
  const sharedFileKey = metadata.segments.find(
    (segment) => segment.timeseries_id === 999,
  ).file_key;
  assert.equal(
    metadata.segments.find((segment) => segment.timeseries_id === 1000).file_key,
    sharedFileKey,
  );
  assert.ok(shard999.files.some((file) => file.key === sharedFileKey));
  assert.ok(shard1000.files.some((file) => file.key === sharedFileKey));
  assert.equal(
    shard999.files.find((file) => file.key === sharedFileKey).sha256,
    shard1000.files.find((file) => file.key === sharedFileKey).sha256,
  );
  assert.ok(
    shard999.timeseries[0].segments.every(
      (segment) => segment.file_key === sharedFileKey,
    ),
  );
  assert.ok(
    shard1000.timeseries.find((entry) => entry.timeseries_id === 1000)
      .segments.every((segment) => segment.file_key === sharedFileKey),
  );

  const continued = shard1000.timeseries.find(
    (entry) => entry.timeseries_id === 1500,
  );
  assert.equal(continued.row_count, 7);
  assert.ok(new Set(continued.segments.map((entry) => entry.file_key)).size > 1);
  assert.ok(
    new Set(
      continued.segments.map((entry) =>
        `${entry.file_key}:${entry.row_group_ordinal}`
      ),
    ).size > 1,
  );
  for (let index = 1; index < continued.segments.length; index += 1) {
    assert.ok(
      continued.segments[index - 1].max_observed_at_utc <=
        continued.segments[index].min_observed_at_utc,
    );
  }
  assert.equal(first.scoped_manifest.payload.coverage.row_count, metadata.row_count);
  assert.deepEqual(
    first.scoped_manifest.payload.coverage.timeseries_ids,
    [999, 1000, 1500],
  );

  const secondMetadata = buildPhase1({
    dayUtc: "2026-01-03",
    connectorId: 2,
    definitions: [[2000, 2]],
  });
  const second = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: secondMetadata,
    canonicalManifest: canonicalManifestFor(secondMetadata),
  });
  const latest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [first, second],
  });
  const latestReordered = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [second, first],
  });
  assert.equal(latest.body, latestReordered.body);
  assert.equal(latest.payload.day_count, 2);
  assert.deepEqual(latest.payload.days, ["2026-01-02", "2026-01-03"]);
  assert.deepEqual({
    child_shards: first.child_shards.map((artifact) => artifact.sha256),
    scoped_manifest: first.scoped_manifest.sha256,
    latest_global: latest.sha256,
  }, {
    // Known deterministic identities for the retained legacy-shard fixture
    // generated over aligned production Parquet.
    child_shards: [
      "fb4d2e186775d3b7c41b6d7a86830db7d98f7bf7a768e6271f23002cab9ef213",
      "8c5fbafab0c0d7a9d996abf598f1272e6a8153bef0e3ab7bd9c1b0cfdf70d307",
    ],
    scoped_manifest: "1d36fde8207a9815789e0aebad1c45a4e892d74a468433f393f5aa6e92527cb7",
    latest_global: "2d3ad47917244e712a7c6c8ee5c814da030174a957b409e5457026f12e56e6b6",
  });
});

test("v3 builders fail closed on file identity, overlap, shard and coverage conflicts", () => {
  const metadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[999, 1], [1000, 1], [1500, 7]],
  });
  const canonicalManifest = canonicalManifestFor(metadata);

  const missingSha = structuredClone(metadata);
  missingSha.files[0].sha256 = null;
  assert.throws(
    () => validateObservationHistoryTargetMetadataForV3(missingSha),
    /file\.sha256 must be lower-case SHA-256/,
  );

  const contradictorySha = structuredClone(metadata);
  contradictorySha.files[0].sha256 = "a".repeat(64);
  assert.throws(
    () => validateObservationHistoryTargetMetadataForV3(contradictorySha),
    /segment file_sha256 disagrees with file identity/,
  );

  const overlapping = structuredClone(metadata);
  const topLevel1000 = overlapping.segments.find(
    (segment) => segment.timeseries_id === 1000,
  );
  const nested1000 = overlapping.files
    .flatMap((file) => file.row_groups)
    .flatMap((rowGroup) => rowGroup.segments)
    .find((segment) => segment.timeseries_id === 1000);
  topLevel1000.row_start = 0;
  topLevel1000.row_group_row_start = 0;
  nested1000.row_start = 0;
  nested1000.row_group_row_start = 0;
  assert.throws(
    () => validateObservationHistoryTargetMetadataForV3(overlapping),
    /segments overlap|impossible row-group\/file coordinates/,
  );

  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata,
    canonicalManifest,
  });
  const wrongShardPayload = structuredClone(hierarchy.child_shards[0].payload);
  wrongShardPayload.timeseries[0].timeseries_id = 1000;
  wrongShardPayload.coverage.timeseries_ids = [1000];
  const wrongShard = reidentifyArtifact(
    hierarchy.child_shards[0],
    wrongShardPayload,
  );
  assert.throws(
    () => buildObservationHistoryIndexV3ScopedManifest({
      metadata,
      canonicalManifest,
      childShards: [wrongShard, hierarchy.child_shards[1]],
    }),
    /out of shard or non-deterministic/,
  );
  assert.throws(
    () => buildObservationHistoryIndexV3ScopedManifest({
      metadata,
      canonicalManifest,
      childShards: [hierarchy.child_shards[0]],
    }),
    /root\/child timeseries coverage disagreement/,
  );
});

test("v3 semantic validators reject rehashed child, root and latest tampering", () => {
  const metadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[999, 1], [1000, 1], [1500, 7]],
  });
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata,
    canonicalManifest: canonicalManifestFor(metadata),
  });
  const childPayload = structuredClone(hierarchy.child_shards[1].payload);
  childPayload.timeseries[0].row_count += 1;
  childPayload.coverage.row_count += 1;
  const tamperedChild = reidentifyArtifact(
    hierarchy.child_shards[1],
    childPayload,
  );
  assert.throws(
    () => validateObservationHistoryIndexV3ChildShardArtifact({
      artifact: tamperedChild,
    }),
    /timeseries totals, bounds, or fields are contradictory/,
  );
  assert.throws(
    () => buildObservationHistoryIndexV3ScopedManifest({
      metadata,
      canonicalManifest: canonicalManifestFor(metadata),
      childShards: [hierarchy.child_shards[0], tamperedChild],
    }),
    /timeseries totals, bounds, or fields are contradictory/,
  );

  const rootPayload = structuredClone(hierarchy.scoped_manifest.payload);
  rootPayload.coverage.row_count += 1;
  const tamperedRoot = reidentifyArtifact(
    hierarchy.scoped_manifest,
    rootPayload,
  );
  assert.throws(
    () => validateObservationHistoryIndexV3ScopedManifestArtifact({
      artifact: tamperedRoot,
      childShards: hierarchy.child_shards,
    }),
    /contradictory identity, coverage, or children/,
  );
  assert.throws(
    () => buildObservationHistoryIndexV3Latest({
      scopedHierarchies: [{
        child_shards: hierarchy.child_shards,
        scoped_manifest: tamperedRoot,
      }],
    }),
    /contradictory identity, coverage, or children/,
  );

  const latest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [hierarchy],
  });
  const latestPayload = structuredClone(latest.payload);
  latestPayload.total_rows += 1;
  const tamperedLatest = reidentifyArtifact(latest, latestPayload);
  assert.throws(
    () => validateObservationHistoryIndexV3LatestArtifact({
      artifact: tamperedLatest,
      scopedHierarchies: [hierarchy],
    }),
    /contradictory roots, summaries, or counters/,
  );

  const missingDependency = {
    ...hierarchy.child_shards[0],
    dependencies: hierarchy.child_shards[0].dependencies.slice(1),
  };
  assert.throws(
    () => validateObservationHistoryIndexV3ChildShardArtifact({
      artifact: missingDependency,
    }),
    /dependencies do not exactly match semantic references/,
  );
});

test("targeted v3 updates equal complete rebuilds and preserve omissions", () => {
  const metadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[999, 1], [1000, 1], [1500, 7]],
  });
  const canonicalManifest = canonicalManifestFor(metadata);
  const first = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata,
    canonicalManifest,
  });
  const secondMetadata = buildPhase1({
    dayUtc: "2026-01-03",
    connectorId: 2,
    definitions: [[2000, 2]],
  });
  const second = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: secondMetadata,
    canonicalManifest: canonicalManifestFor(secondMetadata),
  });
  const existingLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [first, second],
  });

  const replacementPayload = structuredClone(first.child_shards[1].payload);
  const otherKeys = new Set(first.child_shards[0].payload.files.map((file) =>
    file.key
  ));
  const uniqueFile = replacementPayload.files.find((file) =>
    !otherKeys.has(file.key)
  );
  assert.ok(uniqueFile);
  uniqueFile.etag = "known-after-verification";
  const replacementChild = reidentifyArtifact(
    first.child_shards[1],
    replacementPayload,
  );
  validateObservationHistoryIndexV3ChildShardArtifact({
    artifact: replacementChild,
  });

  const targetedRoot = updateObservationHistoryIndexV3ScopedManifest({
    existingScopedManifest: first.scoped_manifest,
    replacementChildShards: [replacementChild],
  });
  const completeRoot = buildObservationHistoryIndexV3ScopedManifest({
    metadata,
    canonicalManifest,
    childShards: [first.child_shards[0], replacementChild],
  });
  assert.equal(targetedRoot.body, completeRoot.body);
  assert.deepEqual(
    targetedRoot.payload.children[0],
    first.scoped_manifest.payload.children[0],
  );
  const targetedHierarchy = {
    child_shards: [first.child_shards[0], replacementChild],
    scoped_manifest: targetedRoot,
  };

  const targetedLatest = updateObservationHistoryIndexV3Latest({
    existingLatest,
    replacementScopedManifests: [targetedRoot],
  });
  const completeLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [targetedHierarchy, second],
  });
  assert.equal(targetedLatest.body, completeLatest.body);
  const unchangedSecondDescriptor = existingLatest.payload.day_summaries
    .find((entry) => entry.day_utc === "2026-01-03").scoped_roots[0];
  assert.deepEqual(
    targetedLatest.payload.day_summaries
      .find((entry) => entry.day_utc === "2026-01-03").scoped_roots[0],
    unchangedSecondDescriptor,
  );

  assert.equal(
    updateObservationHistoryIndexV3ScopedManifest({
      existingScopedManifest: first.scoped_manifest,
    }).body,
    first.scoped_manifest.body,
  );
  assert.equal(
    updateObservationHistoryIndexV3Latest({
      existingLatest,
    }).body,
    existingLatest.body,
  );
  assert.equal(
    updateObservationHistoryIndexV3Latest({
      existingLatest,
      removedScopes: [second.scoped_manifest.payload],
    }).body,
    buildObservationHistoryIndexV3Latest({
      scopedHierarchies: [first],
    }).body,
  );

  const reducedMetadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[1000, 1], [1500, 7]],
  });
  const reducedManifest = canonicalManifestFor(reducedMetadata);
  const reducedChild = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: reducedMetadata,
    canonicalManifest: reducedManifest,
  }).child_shards[0];
  const explicitlyReducedRoot = updateObservationHistoryIndexV3ScopedManifest({
    existingScopedManifest: first.scoped_manifest,
    canonicalManifest: reducedManifest,
    replacementChildShards: [reducedChild],
    removedRangeStarts: [0],
  });
  assert.equal(
    explicitlyReducedRoot.body,
    buildObservationHistoryIndexV3ScopedManifest({
      metadata: reducedMetadata,
      canonicalManifest: reducedManifest,
      childShards: [reducedChild],
    }).body,
  );
  assert.throws(
    () => updateObservationHistoryIndexV3ScopedManifest({
      existingScopedManifest: first.scoped_manifest,
      replacementChildShards: [replacementChild],
      removedRangeStarts: [replacementChild.payload.range_start],
    }),
    /cannot replace and remove one range/,
  );
  assert.throws(
    () => updateObservationHistoryIndexV3Latest({
      existingLatest,
      replacementScopedManifests: [targetedRoot],
      removedScopes: [targetedRoot.payload],
    }),
    /cannot replace and remove one scope/,
  );
});

test("canonical source changes preserve unrelated children and explicit publication order", async () => {
  const firstMetadata = buildPhase1({
    dayUtc: "2026-02-04",
    connectorId: 1,
    definitions: [[999, 5], [1000, 5]],
  });
  const firstCanonicalManifest = canonicalManifestFor(firstMetadata);
  const first = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: firstMetadata,
    canonicalManifest: firstCanonicalManifest,
  });
  const secondMetadata = buildPhase1({
    dayUtc: "2026-02-04",
    connectorId: 1,
    definitions: [[999, 5], [1000, 5]],
    valueOffsetsByTimeseries: { 1000: 1 },
  });
  const secondCanonicalManifest = canonicalManifestFor(secondMetadata);
  const second = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: secondMetadata,
    canonicalManifest: secondCanonicalManifest,
  });

  assert.notEqual(firstCanonicalManifest.sha256, secondCanonicalManifest.sha256);
  assert.equal(first.child_shards[0].body, second.child_shards[0].body);
  assert.equal(first.child_shards[0].sha256, second.child_shards[0].sha256);
  assert.notDeepEqual(
    first.child_shards[0].publication_prerequisites,
    second.child_shards[0].publication_prerequisites,
  );
  assert.equal(
    Object.hasOwn(second.child_shards[0].payload, "canonical_source_manifest"),
    false,
  );
  assert.equal(
    second.child_shards[0].dependencies.some(
      (dependency) => dependency.kind === "canonical_manifest",
    ),
    false,
  );
  assert.deepEqual(
    second.child_shards[0].publication_prerequisites.map(
      (prerequisite) => prerequisite.kind,
    ),
    ["canonical_manifest"],
  );
  assert.notEqual(first.child_shards[1].body, second.child_shards[1].body);

  const targetedRoot = updateObservationHistoryIndexV3ScopedManifest({
    existingScopedManifest: first.scoped_manifest,
    canonicalManifest: secondCanonicalManifest,
    replacementChildShards: [second.child_shards[1]],
  });
  assert.equal(targetedRoot.body, second.scoped_manifest.body);
  assert.deepEqual(
    targetedRoot.payload.children[0],
    first.scoped_manifest.payload.children[0],
  );

  const inconsistentCanonicalManifest = {
    ...secondCanonicalManifest,
    row_count: secondCanonicalManifest.row_count + 1,
    observation_content_hash: "f".repeat(64),
  };
  assert.throws(
    () => updateObservationHistoryIndexV3ScopedManifest({
      existingScopedManifest: first.scoped_manifest,
      canonicalManifest: inconsistentCanonicalManifest,
      replacementChildShards: [second.child_shards[1]],
    }),
    /descriptor rows disagree with canonical source/,
  );

  const firstLatest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [first],
  });
  const targetedLatest = updateObservationHistoryIndexV3Latest({
    existingLatest: firstLatest,
    replacementScopedManifests: [targetedRoot],
  });
  const canonicalObject = canonicalManifestPublicationObject(
    secondMetadata,
    secondCanonicalManifest,
  );
  const changedObjects = [
    targetedLatest,
    targetedRoot,
    second.child_shards[1],
    canonicalObject,
  ];
  const externalReferences = externalReferencesFor(changedObjects);
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects: changedObjects,
    externalReferences,
  });
  const reorderedPlan = buildObservationHistoryIndexV3PublicationPlan({
    objects: [...changedObjects].reverse(),
    externalReferences: [...externalReferences].reverse(),
  });
  assert.equal(plan.schedule_sha256, reorderedPlan.schedule_sha256);
  assert.equal(plan.changed_order_prerequisite_edge_count, 1);
  const positions = new Map(
    plan.entries.map((entry) => [entry.key, entry.position]),
  );
  assert.ok(
    positions.get(canonicalObject.key) <
      positions.get(second.child_shards[1].key),
  );
  assert.ok(
    positions.get(second.child_shards[1].key) < positions.get(targetedRoot.key),
  );
  assert.ok(positions.get(targetedRoot.key) < positions.get(targetedLatest.key));

  assert.throws(
    () => buildObservationHistoryIndexV3PublicationPlan({
      objects: [second.child_shards[1]],
      externalReferences: second.child_shards[1].dependencies.map(
        (dependency) => ({ ...dependency, verified: true, durable: true }),
      ),
    }),
    /Missing required v3 publication order prerequisite/,
  );
  const contradictoryPrerequisiteChild = {
    ...second.child_shards[1],
    publication_prerequisites: [{
      ...second.child_shards[1].publication_prerequisites[0],
      sha256: "a".repeat(64),
    }],
  };
  assert.throws(
    () => buildObservationHistoryIndexV3PublicationPlan({
      objects: [contradictoryPrerequisiteChild, canonicalObject],
      externalReferences: externalReferencesFor([
        contradictoryPrerequisiteChild,
        canonicalObject,
      ]),
    }),
    /Contradictory v3 publication order prerequisite identity/,
  );

  const stored = new Map();
  const events = [];
  await finalizeObservationHistoryIndexV3Publication({
    plan,
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      stored.set(key, Buffer.from(body));
      return { ok: true, status: "succeeded" };
    },
    getObject: async ({ key }) => ({ body: stored.get(key) }),
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  assert.ok(
    events.indexOf(`durable:${canonicalObject.key}`) <
      events.indexOf(`put:${second.child_shards[1].key}`),
  );
  assert.ok(
    events.indexOf(`durable:${second.child_shards[1].key}`) <
      events.indexOf(`put:${targetedRoot.key}`),
  );
  assert.ok(
    events.indexOf(`durable:${targetedRoot.key}`) <
      events.indexOf(`put:${targetedLatest.key}`),
  );
});

test("v3 publication plan and finaliser enforce child verification durability", async () => {
  const metadata = buildPhase1({
    dayUtc: "2026-01-02",
    connectorId: 1,
    definitions: [[999, 1], [1000, 1], [1500, 7]],
  });
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata,
    canonicalManifest: canonicalManifestFor(metadata),
  });
  const latest = buildObservationHistoryIndexV3Latest({
    scopedHierarchies: [hierarchy],
  });
  const objects = [
    latest,
    hierarchy.scoped_manifest,
    ...[...hierarchy.child_shards].reverse(),
  ];
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects,
    externalReferences: externalReferencesFor(objects),
  });
  const positions = new Map(
    plan.entries.map((entry) => [entry.key, entry.position]),
  );
  for (const child of hierarchy.child_shards) {
    assert.ok(
      positions.get(child.key) < positions.get(hierarchy.scoped_manifest.key),
    );
  }
  assert.ok(
    positions.get(hierarchy.scoped_manifest.key) < positions.get(latest.key),
  );

  const stored = new Map();
  const events = [];
  const result = await finalizeObservationHistoryIndexV3Publication({
    plan,
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      stored.set(key, Buffer.from(body));
      return { ok: true, status: "succeeded" };
    },
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      return { body: stored.get(key) };
    },
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  assert.equal(result.status, "succeeded");
  for (const child of hierarchy.child_shards) {
    assert.ok(
      events.indexOf(`durable:${child.key}`) <
        events.indexOf(`put:${hierarchy.scoped_manifest.key}`),
    );
  }
  assert.ok(
    events.indexOf(`durable:${hierarchy.scoped_manifest.key}`) <
      events.indexOf(`put:${latest.key}`),
  );

  const failedEvents = [];
  await assert.rejects(
    finalizeObservationHistoryIndexV3Publication({
      plan,
      putIfChanged: async ({ key }) => {
        failedEvents.push(`put:${key}`);
        return { ok: true, status: "succeeded" };
      },
      getObject: async ({ key }) => ({
        body: key === hierarchy.child_shards[0].key
          ? Buffer.from("wrong")
          : plan.entries.find((entry) => entry.key === key).body,
      }),
      recordDurableEvidence: async ({ key }) => {
        failedEvents.push(`durable:${key}`);
        return { durable: true };
      },
    }),
    /post-PUT GET verification failed/,
  );
  assert.equal(failedEvents.includes(`put:${hierarchy.scoped_manifest.key}`), false);
  assert.equal(failedEvents.includes(`put:${latest.key}`), false);
});

test("observation-only v3 resolver rejects every unsupported generation", () => {
  assert.equal(
    resolveObservationHistoryIndexV3BuildConfig({
      env: { UK_AQ_R2_HISTORY_INDEX_VERSION: "v3" },
    }).index_root,
    "history/_index_v3/observations_timeseries",
  );
  assert.equal(
    resolveObservationHistoryIndexV3BuildConfig({
      env: { UK_AQ_R2_HISTORY_INDEX_VERSION: "v2" },
      requestedIndexGeneration: "v3",
    }).index_generation,
    "v3",
  );
  for (const generation of ["", "v1", "v2", "v4", "V3", " v3", "v3 ", " v3 ", "v3\n"]) {
    assert.throws(
      () => resolveObservationHistoryIndexV3BuildConfig({
        env: { UK_AQ_R2_HISTORY_INDEX_VERSION: generation },
      }),
      /Unsupported observation-history index generation/,
    );
  }
});
