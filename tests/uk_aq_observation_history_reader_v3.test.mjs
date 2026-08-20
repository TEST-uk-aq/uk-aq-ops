import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildObservationHistoryIndexV3ScopedHierarchy,
  encodeObservationHistoryIndexV3Json,
} from "../workers/shared/uk_aq_observation_history_index_v3.mjs";
import {
  createObservationHistoryV3RangeBudget,
  createPinnedObservationHistoryV3RandomAccessFile,
  createR2PinnedObservationHistoryV3RandomAccessFile,
} from "../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS,
  buildObservationHistoryV3ChildReadKey,
  createObservationHistoryV3FooterCache,
  observationHistoryV3FooterCacheKey,
  readObservationHistoryExactV3,
} from "../workers/shared/uk_aq_observation_history_reader_v3.mjs";
import {
  buildCanonicalObservationTimeseriesBoundedFiles,
} from "../workers/shared/uk_aq_observation_history_target_writer.mjs";

const WRITER_LIMITS = Object.freeze({
  target_row_group_rows: 2,
  max_row_group_rows: 2,
  target_file_rows: 4,
  max_file_rows: 4,
  target_file_bytes: 1_000_000,
  max_file_bytes: 2_000_000,
  max_row_groups_per_file: 2,
});

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function hexBytes(value) {
  return Uint8Array.from(
    value.match(/../g),
    (pair) => Number.parseInt(pair, 16),
  ).buffer;
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

function dayRows(dayUtc, valueOffset = 0) {
  const requested = Array.from({ length: 5 }, (_, minute) => ({
    connector_id: 7,
    station_id: 70,
    timeseries_id: 100,
    pollutant_code: "pm25",
    observed_at_utc: `${dayUtc}T00:0${minute}:00.000Z`,
    value: valueOffset + minute + 0.25,
    verification_status: minute % 2 ? "P" : null,
  }));
  return [
    ...requested,
    {
      connector_id: 7,
      station_id: 71,
      timeseries_id: 101,
      pollutant_code: "pm25",
      observed_at_utc: `${dayUtc}T00:02:30.000Z`,
      value: valueOffset + 999,
      verification_status: null,
    },
  ];
}

function buildDay(dayUtc, valueOffset = 0) {
  const phase1 = buildCanonicalObservationTimeseriesBoundedFiles(
    dayRows(dayUtc, valueOffset),
    {
      limits: WRITER_LIMITS,
      fileKeyForOrdinal: (ordinal) =>
        `history/v2/observations/day_utc=${dayUtc}/connector_id=7/` +
        `pollutant_code=pm25/part-${String(ordinal).padStart(5, "0")}.parquet`,
    },
  );
  const hierarchy = buildObservationHistoryIndexV3ScopedHierarchy({
    metadata: phase1.metadata,
    canonicalManifest: canonicalManifestFor(phase1.metadata),
  });
  const child = hierarchy.child_shards.find((artifact) =>
    artifact.payload.timeseries.some((entry) => entry.timeseries_id === 100)
  );
  assert.ok(child);
  return { phase1, hierarchy, child };
}

function buildFixture() {
  const days = [buildDay("2026-08-18", 0), buildDay("2026-08-19", 10)];
  const unusedDay = buildDay("2026-08-20", 20);
  const indexObjects = new Map();
  const files = new Map();
  for (const fixtureDay of [...days, unusedDay]) {
    for (const child of fixtureDay.hierarchy.child_shards) {
      indexObjects.set(child.key, child.body);
    }
    for (const fileBody of fixtureDay.phase1.file_bodies) {
      const metadata = fixtureDay.phase1.metadata.files.find(
        (file) => file.key === fileBody.key,
      );
      files.set(fileBody.key, {
        body: fileBody.body,
        metadata,
        etag: `fixture-${metadata.sha256.slice(0, 16)}`,
      });
    }
  }

  const observations = { indexKeys: [], ranges: [], opened: [] };
  const source = Object.freeze({
    async getIndexObject({ key, maxBytes, diagnostics }) {
      observations.indexKeys.push(key);
      const body = indexObjects.get(key);
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      if (bytes.byteLength > maxBytes) throw new Error("fixture index over budget");
      return { key, body, byte_size: bytes.byteLength };
    },
    async openParquetFile({ identity, budget, diagnostics }) {
      const stored = files.get(identity.key);
      if (!stored) throw new Error(`fixture file missing: ${identity.key}`);
      diagnostics.identity_head_reads += 1;
      observations.opened.push(identity.key);
      return createPinnedObservationHistoryV3RandomAccessFile({
        identity,
        objectMetadata: {
          byte_size: stored.body.byteLength,
          sha256: stored.metadata.sha256,
          etag: stored.etag,
        },
        budget,
        readRange: async ({ key, offset, length }) => {
          observations.ranges.push({ key, offset, length });
          return stored.body.slice(offset, offset + length);
        },
      });
    },
  });
  return { days, unusedDay, indexObjects, files, observations, source };
}

function query(source, options = {}) {
  return readObservationHistoryExactV3({
    source,
    indexGeneration: "v3",
    historyVersion: "v2",
    timeseriesId: 100,
    connectorId: 7,
    pollutantCode: "pm25",
    startUtc: "2026-08-18T00:00:00.000Z",
    endUtc: "2026-08-20T00:00:00.000Z",
    ...options,
  });
}

test("v3 exact reader follows Phase 1 segments across row groups, files, and days", async () => {
  const fixture = buildFixture();
  const result = await query(fixture.source);

  assert.equal(result.response_complete, true);
  assert.equal(result.has_gap, false);
  assert.equal(result.rows.length, 10);
  assert.deepEqual(
    result.rows.map((row) => row.timeseries_id),
    Array(10).fill(100),
  );
  assert.deepEqual(
    result.rows.map((row) => row.value),
    [0.25, 1.25, 2.25, 3.25, 4.25, 10.25, 11.25, 12.25, 13.25, 14.25],
  );
  assert.deepEqual(
    result.diagnostics.projected_columns,
    OBSERVATION_HISTORY_V3_PROJECTED_COLUMNS,
  );
  assert.equal(result.diagnostics.pages_selected, 0);
  assert.equal(result.diagnostics.page_selection_supported, false);
  assert.match(
    result.diagnostics.page_selection_unavailable_reason,
    /dictionary-decode-unsafe/,
  );
  assert.ok(result.diagnostics.page_indexes_available > 0);
  assert.ok(result.diagnostics.column_chunks_selected > 0);
  assert.ok(result.diagnostics.range_coalesces > 0);
  assert.ok(result.diagnostics.row_groups_selected > 2);
  assert.ok(result.diagnostics.parquet_files_selected > 2);
  assert.equal(fixture.observations.indexKeys.length, 2);
  assert.ok(
    fixture.observations.indexKeys.every((key) => !key.includes("2026-08-20")),
  );
  assert.ok(fixture.observations.ranges.length > 0);
  for (const range of fixture.observations.ranges) {
    const size = fixture.files.get(range.key).body.byteLength;
    assert.ok(range.offset >= 0 && range.offset + range.length <= size);
    assert.notDeepEqual([range.offset, range.length], [0, size]);
  }
  assert.ok(fixture.observations.ranges.some((range) => {
    const size = fixture.files.get(range.key).body.byteLength;
    return range.offset + range.length === size && range.length === 8;
  }));

  const narrowed = await query(fixture.source, {
    startUtc: "2026-08-18T00:02:00.000Z",
    endUtc: "2026-08-19T00:03:00.000Z",
  });
  assert.deepEqual(
    narrowed.rows.map((row) => row.observed_at_utc),
    [
      "2026-08-18T00:02:00.000Z",
      "2026-08-18T00:03:00.000Z",
      "2026-08-18T00:04:00.000Z",
      "2026-08-19T00:00:00.000Z",
      "2026-08-19T00:01:00.000Z",
      "2026-08-19T00:02:00.000Z",
    ],
  );
});

test("v3 footer cache is content-identity scoped and still re-verifies file identity", async () => {
  const fixture = buildFixture();
  const footerCache = createObservationHistoryV3FooterCache();
  const first = await query(fixture.source, { footerCache });
  const firstRangeCount = fixture.observations.ranges.length;
  const firstOpenCount = fixture.observations.opened.length;
  const second = await query(fixture.source, { footerCache });

  assert.ok(first.diagnostics.footer_cache_misses > 0);
  assert.equal(second.diagnostics.footer_cache_misses, 0);
  assert.equal(
    second.diagnostics.footer_cache_hits,
    first.diagnostics.parquet_files_selected,
  );
  assert.equal(
    fixture.observations.opened.length - firstOpenCount,
    second.diagnostics.parquet_files_selected,
  );
  assert.ok(fixture.observations.ranges.length > firstRangeCount);

  const file = fixture.days[0].child.payload.files[0];
  assert.notEqual(
    observationHistoryV3FooterCacheKey(file),
    observationHistoryV3FooterCacheKey({ ...file, sha256: "a".repeat(64) }),
  );
});

test("v3 R2 adapter pins HEAD SHA-256 and conditionally ranges the same ETag", async () => {
  const fixture = buildFixture();
  const [key, stored] = fixture.files.entries().next().value;
  const identity = fixture.days[0].child.payload.files.find((file) =>
    file.key === key
  );
  const calls = [];
  const bucket = {
    async head(requestedKey) {
      assert.equal(requestedKey, key);
      return {
        size: stored.body.byteLength,
        etag: "CaseSensitiveFixtureETag",
        checksums: { sha256: hexBytes(stored.metadata.sha256) },
      };
    },
    async get(requestedKey, options) {
      assert.equal(requestedKey, key);
      calls.push(options);
      const { offset, length } = options.range;
      return {
        body: {},
        size: stored.body.byteLength,
        etag: "CaseSensitiveFixtureETag",
        checksums: { sha256: hexBytes(stored.metadata.sha256) },
        range: { offset, length },
        async arrayBuffer() {
          return stored.body.slice(offset, offset + length);
        },
      };
    },
  };
  const budget = createObservationHistoryV3RangeBudget({
    maxRangeReads: 2,
    maxBytesRequested: 64,
  });
  const file = await createR2PinnedObservationHistoryV3RandomAccessFile({
    bucket,
    identity,
    budget,
    diagnostics: { identity_head_reads: 0 },
  });
  const bytes = await file.slice(10, 26);
  assert.equal(bytes.byteLength, 16);
  assert.deepEqual(calls, [{
    onlyIf: { etagMatches: "CaseSensitiveFixtureETag" },
    range: { offset: 10, length: 16 },
  }]);

  let bodyReads = 0;
  await assert.rejects(
    createR2PinnedObservationHistoryV3RandomAccessFile({
      bucket: {
        async head() {
          return { size: identity.byte_size, etag: "etag", checksums: {} };
        },
        async get() {
          bodyReads += 1;
        },
      },
      identity,
      budget,
    }),
    /lacks stored R2 SHA-256 metadata/,
  );
  assert.equal(bodyReads, 0);
});

test("v3 reader fails closed before trusting ranges on identity, contract, and budget conflicts", async () => {
  const wrongIdentity = buildFixture();
  const firstFile = wrongIdentity.files.values().next().value;
  firstFile.metadata = { ...firstFile.metadata, sha256: "a".repeat(64) };
  await assert.rejects(
    query(wrongIdentity.source),
    /Pinned v3 object SHA-256 mismatch/,
  );
  assert.equal(wrongIdentity.observations.ranges.length, 0);

  for (const [field, value, message] of [
    ["byte_size", 1, /byte-size mismatch/],
    ["history_schema_version", 999, /unsupported physical file identity/],
  ]) {
    const contradictory = buildFixture();
    const childKey = buildObservationHistoryV3ChildReadKey({
      dayUtc: "2026-08-18",
      connectorId: 7,
      pollutantCode: "pm25",
      timeseriesId: 100,
    });
    const childPayload = structuredClone(contradictory.days[0].child.payload);
    childPayload.files[0][field] = value;
    contradictory.indexObjects.set(
      childKey,
      encodeObservationHistoryIndexV3Json(childPayload),
    );
    await assert.rejects(query(contradictory.source), message);
    assert.equal(contradictory.observations.ranges.length, 0);
  }

  const wrongLayout = buildFixture();
  const key = buildObservationHistoryV3ChildReadKey({
    dayUtc: "2026-08-18",
    connectorId: 7,
    pollutantCode: "pm25",
    timeseriesId: 100,
  });
  const payload = structuredClone(wrongLayout.days[0].child.payload);
  payload.physical_layout_version = "unsupported-layout";
  wrongLayout.indexObjects.set(key, encodeObservationHistoryIndexV3Json(payload));
  await assert.rejects(query(wrongLayout.source), /supported generation is contradictory/);
  assert.equal(wrongLayout.observations.ranges.length, 0);

  const limited = buildFixture();
  await assert.rejects(
    query(limited.source, { limits: { max_total_range_reads: 1 } }),
    (error) => {
      assert.match(error.message, /range-read count budget exceeded/);
      assert.equal(error.diagnostics.r2_range_reads, 1);
      return true;
    },
  );
  assert.ok(limited.observations.ranges.length <= 1);

  await assert.rejects(
    query(buildFixture().source, { indexGeneration: "v2" }),
    /requires index generation v3/,
  );
});

test("v3 reader reports missing intersecting child shards as incomplete", async () => {
  const fixture = buildFixture();
  fixture.indexObjects.delete(buildObservationHistoryV3ChildReadKey({
    dayUtc: "2026-08-19",
    connectorId: 7,
    pollutantCode: "pm25",
    timeseriesId: 100,
  }));
  const result = await query(fixture.source);
  assert.equal(result.response_complete, false);
  assert.equal(result.has_gap, true);
  assert.deepEqual(result.partial_reasons, ["missing_v3_child_shard"]);
  assert.equal(result.rows.length, 5);
  assert.equal(result.diagnostics.missing_index_keys.length, 1);
});
