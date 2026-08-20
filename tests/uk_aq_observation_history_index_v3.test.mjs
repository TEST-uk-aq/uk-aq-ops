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
  resolveObservationHistoryIndexV3BuildConfig,
  validateObservationHistoryTargetMetadataForV3,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";

const limits = Object.freeze({
  target_row_group_rows: 4,
  max_row_group_rows: 4,
  target_file_rows: 5,
  max_file_rows: 5,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function makeRows({ dayUtc, connectorId, definitions }) {
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
      value: timeseriesId + rowIndex / 10,
      verification_status: rowIndex % 2 ? "P" : null,
    }))
  );
}

function buildPhase1({ dayUtc, connectorId, definitions }) {
  const rows = makeRows({ dayUtc, connectorId, definitions });
  return buildCanonicalObservationTimeseriesBoundedFiles(rows, {
    limits,
    fileKeyForOrdinal: (ordinal) =>
      `history/v2/observations/day_utc=${dayUtc}/connector_id=${connectorId}` +
      `/pollutant_code=pm25/part-${String(ordinal).padStart(5, "0")}.parquet`,
  }).metadata;
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

function externalDependenciesFor(objects) {
  const changedKeys = new Set(objects.map((object) => object.key));
  const byKey = new Map();
  for (const object of objects) {
    for (const dependency of object.dependencies) {
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
    scopedManifests: [first.scoped_manifest, second.scoped_manifest],
  });
  const latestReordered = buildObservationHistoryIndexV3Latest({
    scopedManifests: [second.scoped_manifest, first.scoped_manifest],
  });
  assert.equal(latest.body, latestReordered.body);
  assert.equal(latest.payload.day_count, 2);
  assert.deepEqual(latest.payload.days, ["2026-01-02", "2026-01-03"]);
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
    /segments overlap/,
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
    /wrong or duplicate shard assignment/,
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
    scopedManifests: [hierarchy.scoped_manifest],
  });
  const objects = [
    latest,
    hierarchy.scoped_manifest,
    ...[...hierarchy.child_shards].reverse(),
  ];
  const plan = buildObservationHistoryIndexV3PublicationPlan({
    objects,
    externalDependencies: externalDependenciesFor(objects),
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
  for (const generation of ["", "v1", "v2", "v4"]) {
    assert.throws(
      () => resolveObservationHistoryIndexV3BuildConfig({
        env: { UK_AQ_R2_HISTORY_INDEX_VERSION: generation },
      }),
      /Unsupported observation-history index generation/,
    );
  }
});
