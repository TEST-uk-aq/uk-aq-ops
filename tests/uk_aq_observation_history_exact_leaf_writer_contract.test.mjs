import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3,
  OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  readObservationHistoryExactLeafPageV3,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";
import {
  createPinnedObservationHistoryV3RandomAccessFile,
} from "../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID,
  OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
  OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
} from "../workers/shared/uk_aq_observation_history_target_writer.mjs";

const DAY_UTC = "2026-01-02";
const TIMESERIES_ID = 7421;

function exactArrayBuffer(value) {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function rows() {
  return Array.from({ length: 1025 }, (_, index) => ({
    connector_id: 1,
    station_id: 7001,
    timeseries_id: TIMESERIES_ID,
    pollutant_code: "pm25",
    observed_at_utc: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
    value: 10 + index / 100,
    verification_status: index % 2 ? "P" : null,
  }));
}

function readerSource(...preparedPartitions) {
  const indexBodies = new Map(
    preparedPartitions.flatMap((prepared) => prepared.v3_hierarchy.publication_objects).map((entry) => [
      entry.key,
      Buffer.from(entry.body, "utf8"),
    ]),
  );
  const parquetBodies = new Map(
    preparedPartitions.flatMap((prepared) => prepared.file_intents)
      .map((entry) => [entry.key, Buffer.from(entry.body)]),
  );
  return {
    async getIndexObject({ key }) {
      const body = indexBodies.get(key);
      return body
        ? { key, body: exactArrayBuffer(body), byte_size: body.byteLength }
        : null;
    },
    openParquetFile({ identity, budget }) {
      const body = parquetBodies.get(identity.key);
      assert.ok(body, `missing fixture Parquet ${identity.key}`);
      return createPinnedObservationHistoryV3RandomAccessFile({
        identity,
        objectMetadata: {
          byte_size: body.byteLength,
          sha256: identity.sha256,
          etag: null,
        },
        budget,
        readRange: async ({ offset, length }) =>
          exactArrayBuffer(body.subarray(offset, offset + length)),
      });
    },
  };
}

function schema4CompatibleFixture(prepared) {
  const publications = prepared.v3_hierarchy.publication_objects.map((entry) => ({ ...entry }));
  const leaf = publications.find((entry) => entry.payload.kind === OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3);
  const manifest = publications.find((entry) => entry.payload.kind === OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3);
  const leafPayload = {
    ...leaf.payload,
    history_schema_version: 4,
    writer_version: "parquet-wasm-zstd-v4",
  };
  const leafBody = `${JSON.stringify(leafPayload, null, 2)}\n`;
  const leafSha256 = createHash("sha256").update(leafBody).digest("hex");
  Object.assign(leaf, {
    payload: leafPayload,
    body: leafBody,
    byte_size: Buffer.byteLength(leafBody),
    sha256: leafSha256,
  });
  const descriptor = manifest.payload.leaves_by_timeseries_id[String(TIMESERIES_ID)];
  const manifestPayload = {
    ...manifest.payload,
    history_schema_version: 4,
    writer_version: "parquet-wasm-zstd-v4",
    decode_profile: {
      ...manifest.payload.decode_profile,
      root_schema_element: {
        ...manifest.payload.decode_profile.root_schema_element,
        num_children: 6,
      },
    },
    leaves_by_timeseries_id: {
      ...manifest.payload.leaves_by_timeseries_id,
      [String(TIMESERIES_ID)]: [descriptor[0], Buffer.byteLength(leafBody), leafSha256],
    },
  };
  const manifestBody = `${JSON.stringify(manifestPayload, null, 2)}\n`;
  Object.assign(manifest, {
    payload: manifestPayload,
    body: manifestBody,
    byte_size: Buffer.byteLength(manifestBody),
    sha256: createHash("sha256").update(manifestBody).digest("hex"),
  });
  return {
    ...prepared,
    v3_hierarchy: {
      ...prepared.v3_hierarchy,
      publication_objects: publications,
    },
  };
}

function decodeCursor(cursor) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

const EXACT_READER_INDEX = Object.freeze({
  root: DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT,
  alignedIndexRoot:
    `${DEFAULT_OBSERVATION_HISTORY_EXACT_LEAF_INDEX_V3_ROOT}/_aligned`,
  alignedDataRoot: "history/v3/observations",
  indexGeneration: "v3",
  historyVersion: "v2",
  physicalLayoutVersion: OBSERVATION_HISTORY_PHYSICAL_LAYOUT_VERSION,
  alignedRowCap: OBSERVATION_HISTORY_ALIGNED_ROW_CAP,
  decodeProfileId: OBSERVATION_HISTORY_EXACT_LEAF_DECODE_PROFILE_ID,
  manifestKind: OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3,
  leafKind: OBSERVATION_HISTORY_EXACT_LEAF_KIND_V3,
  additionalCommonFields: {
    exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION,
  },
});

test("production aligned writer output remains directly consumable by the exact reader", async () => {
  const logicalRows = rows();
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: logicalRows,
    targetWriterGitSha: "1".repeat(40),
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
  const request = {
    source: readerSource(prepared),
    timeseriesId: TIMESERIES_ID,
    connectorId: 1,
    pollutantCode: "pm25",
    startUtc: `${DAY_UTC}T00:00:00.000Z`,
    endUtc: "2026-01-03T00:00:00.000Z",
    index: EXACT_READER_INDEX,
  };

  const first = await readObservationHistoryExactLeafPageV3(request);
  const second = await readObservationHistoryExactLeafPageV3({
    ...request,
    physicalCursor: first.physical_page.next_cursor,
  });

  assert.equal(first.rows.length, 1024);
  assert.equal(second.rows.length, 1);
  assert.equal(first.physical_schemas.length, 1);
  assert.equal(first.physical_schema.history_schema_version, 3);
  assert.equal(first.physical_schema.writer_version, "parquet-wasm-zstd-v3");
  assert.equal(first.response_complete, false);
  assert.equal(second.response_complete, true);
  assert.deepEqual(
    [...first.rows, ...second.rows].map((row) => ({
      observed_at_utc: row.observed_at_utc,
      value: row.value,
    })),
    logicalRows.map((row) => ({
      observed_at_utc: row.observed_at_utc,
      value: row.value,
    })),
  );
  for (const result of [first, second]) {
    assert.equal(result.diagnostics.parquet_footer_fetched, false);
    assert.equal(result.diagnostics.parquet_footer_parsed, false);
    assert.equal(result.diagnostics.timeseries_id_decoded, false);
    assert.ok(result.diagnostics.r2_range_reads <= 2);
  }
});

test("exact scoped coverage uses temporal bounds across all timeseries", async () => {
  const logicalRows = [
    {
      connector_id: 1,
      station_id: 7001,
      timeseries_id: 100,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T10:00:00.000Z`,
      value: 10,
      verification_status: null,
    },
    {
      connector_id: 1,
      station_id: 7001,
      timeseries_id: 100,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T11:00:00.000Z`,
      value: 11,
      verification_status: null,
    },
    {
      connector_id: 1,
      station_id: 7002,
      timeseries_id: 200,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T01:00:00.000Z`,
      value: 20,
      verification_status: null,
    },
    {
      connector_id: 1,
      station_id: 7002,
      timeseries_id: 200,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T02:00:00.000Z`,
      value: 21,
      verification_status: null,
    },
  ];
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: logicalRows,
    targetWriterGitSha: "1".repeat(40),
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
  assert.deepEqual(
    prepared.v3_hierarchy.scoped_manifest.payload.coverage,
    {
      row_count: 4,
      timeseries_count: 2,
      min_observed_at_utc: `${DAY_UTC}T01:00:00.000Z`,
      max_observed_at_utc: `${DAY_UTC}T11:00:00.000Z`,
      physical_file_count: 1,
      physical_leaf_count: 2,
    },
  );
  assert.deepEqual(
    Object.keys(
      prepared.v3_hierarchy.scoped_manifest.payload.leaves_by_timeseries_id,
    ),
    ["100", "200"],
  );

  const result = await readObservationHistoryExactLeafPageV3({
    source: readerSource(prepared),
    timeseriesId: 100,
    connectorId: 1,
    pollutantCode: "pm25",
    startUtc: `${DAY_UTC}T00:00:00.000Z`,
    endUtc: "2026-01-03T00:00:00.000Z",
    index: EXACT_READER_INDEX,
  });
  assert.deepEqual(
    result.rows,
    logicalRows.slice(0, 2).map((row) => ({
      timeseries_id: row.timeseries_id,
      observed_at_utc: row.observed_at_utc,
      value: row.value,
    })),
  );
  assert.equal(result.response_complete, true);
});

test("exact reader cursor v3 pins mixed schema-3 and schema-4 scope identities", async () => {
  const partition = (dayUtc, observedAtUtc, value) => buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: [{
      connector_id: 1,
      station_id: 7001,
      timeseries_id: TIMESERIES_ID,
      pollutant_code: "pm25",
      observed_at_utc: observedAtUtc,
      value,
      verification_status: null,
    }],
    targetWriterGitSha: "1".repeat(40),
    backedUpAtUtc: `${dayUtc}T23:59:59.000Z`,
  });
  const older = partition("2026-01-02", "2026-01-02T23:30:00.000Z", 1);
  const newer = schema4CompatibleFixture(
    partition("2026-01-03", "2026-01-03T00:30:00.000Z", 2),
  );
  const request = {
    source: readerSource(older, newer),
    timeseriesId: TIMESERIES_ID,
    connectorId: 1,
    pollutantCode: "pm25",
    startUtc: "2026-01-02T23:00:00.000Z",
    endUtc: "2026-01-03T23:00:00.000Z",
    index: EXACT_READER_INDEX,
  };

  const first = await readObservationHistoryExactLeafPageV3(request);
  assert.deepEqual(first.physical_schemas.map((identity) => [
    identity.history_schema_version,
    identity.writer_version,
  ]), [
    [3, "parquet-wasm-zstd-v3"],
    [4, "parquet-wasm-zstd-v4"],
  ]);
  assert.equal(first.physical_schema, null);
  const cursor = decodeCursor(first.physical_page.next_cursor);
  assert.equal(cursor.schema_version, 3);
  assert.equal(cursor.request.writer_version, undefined);
  assert.deepEqual(cursor.discovery.scopes.map((scope) =>
    scope.physical_identity.history_schema_version), [3, 4]);
  assert.equal(cursor.next.physical_identity.history_schema_version, 4);

  const second = await readObservationHistoryExactLeafPageV3({
    ...request,
    physicalCursor: first.physical_page.next_cursor,
  });
  assert.deepEqual([...first.rows, ...second.rows].map((row) => row.value), [1, 2]);
  assert.equal(second.response_complete, true);

  const stale = { ...cursor, schema_version: 2 };
  await assert.rejects(
    readObservationHistoryExactLeafPageV3({
      ...request,
      physicalCursor: Buffer.from(JSON.stringify(stale)).toString("base64url"),
    }),
    (error) => error.code === "physical_cursor_invalid",
  );

  const contradictory = structuredClone(cursor);
  contradictory.discovery.scopes[1].physical_identity.writer_version =
    "parquet-wasm-zstd-v3";
  await assert.rejects(
    readObservationHistoryExactLeafPageV3({
      ...request,
      physicalCursor: Buffer.from(JSON.stringify(contradictory)).toString("base64url"),
    }),
    (error) => error.code === "physical_cursor_invalid",
  );
});
