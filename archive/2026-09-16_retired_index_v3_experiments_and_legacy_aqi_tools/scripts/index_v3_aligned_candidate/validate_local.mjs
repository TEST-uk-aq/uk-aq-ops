#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createObservationHistoryV3FooterCache,
  readObservationHistoryExactV3,
  validateObservationHistoryV3ChildForRead,
} from "../../workers/shared/uk_aq_observation_history_reader_v3.mjs";
import {
  validateObservationHistoryIndexV3ScopedManifestBody,
} from "../../workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs";
import {
  createPinnedObservationHistoryV3RandomAccessFile,
} from "../../workers/shared/uk_aq_observation_history_random_access_v3.mjs";

const IDENTITY = Object.freeze({
  history_schema_version: 3,
  writer_version: "pyarrow-zstd-timeseries-aligned-candidate-v1",
  physical_layout_version: "timeseries-aligned-v2",
  parquet_footer_identity: "created_by_and_uk_aq_schema_metadata",
  parquet_created_by: "parquet-cpp-arrow version 25.0.1",
});
const PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function localSource(root) {
  const read = (key) => fs.readFileSync(path.join(root, "objects", key));
  return Object.freeze({
    async getIndexObject({ key, maxBytes }) {
      const bytes = read(key);
      assert.ok(bytes.byteLength <= maxBytes);
      return { key, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), byte_size: bytes.byteLength };
    },
    openParquetFile({ identity, budget }) {
      const bytes = read(identity.key);
      return createPinnedObservationHistoryV3RandomAccessFile({
        identity,
        objectMetadata: { byte_size: bytes.byteLength, sha256: sha256(bytes), etag: sha256(bytes) },
        budget,
        readRange: async ({ offset, length }) => {
          const selected = bytes.subarray(offset, offset + length);
          return selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength);
        },
      });
    },
  });
}

function args(argv) {
  const index = argv.indexOf("--output-root");
  if (index < 0 || !argv[index + 1]) throw new Error("--output-root is required");
  return path.resolve(argv[index + 1]);
}

async function main() {
  const root = args(process.argv.slice(2));
  const plan = JSON.parse(fs.readFileSync(path.join(root, "publication-plan.json")));
  assert.equal(plan.environment, "TEST");
  assert.equal(plan.prototype_prefix, PREFIX);
  assert.ok(plan.objects.every((entry) => entry.key.startsWith(`${PREFIX}/cap_rows=`)));
  const source = localSource(root);

  for (const entry of plan.objects.filter((item) => item.key.endsWith("/manifest.json"))) {
    const body = fs.readFileSync(path.join(root, entry.local_path));
    validateObservationHistoryIndexV3ScopedManifestBody({
      key: entry.key,
      body,
      indexRoot: entry.key.slice(0, entry.key.indexOf("/day_utc=")),
      physicalIdentity: IDENTITY,
    });
  }
  for (const entry of plan.objects.filter((item) => /\/range=\d{6,}-\d{6,}\.json$/.test(item.key))) {
    const body = fs.readFileSync(path.join(root, entry.local_path));
    const payload = JSON.parse(body);
    const indexRoot = entry.key.slice(0, entry.key.indexOf("/day_utc="));
    validateObservationHistoryV3ChildForRead({
      key: entry.key,
      body,
      dayUtc: payload.day_utc,
      connectorId: payload.connector_id,
      pollutantCode: payload.pollutant_code,
      timeseriesId: payload.timeseries[0].timeseries_id,
      indexRoot,
      physicalIdentity: IDENTITY,
    });
    assert.throws(() => validateObservationHistoryV3ChildForRead({
      key: entry.key,
      body,
      dayUtc: payload.day_utc,
      connectorId: payload.connector_id,
      pollutantCode: payload.pollutant_code,
      timeseriesId: payload.timeseries[0].timeseries_id,
      indexRoot,
    }), /unsupported|contradictory/);
  }

  const cases = [
    { day: "2026-08-20", connector: 1, ts: 218, rows: 24 },
    { day: "2026-08-20", connector: 7, ts: 7421, rows: 288 },
    { day: "2026-04-03", connector: 7, ts: 7421, rows: 12505 },
  ];
  const results = [];
  for (const cap of [1024, 2048, 4096]) {
    const indexRoot = `${PREFIX}/cap_rows=${cap}/observations_timeseries`;
    for (const item of cases) {
      const result = await readObservationHistoryExactV3({
        source,
        indexGeneration: "v3",
        historyVersion: "v2",
        timeseriesId: item.ts,
        connectorId: item.connector,
        pollutantCode: "pm25",
        startUtc: `${item.day}T00:00:00.000Z`,
        endUtc: new Date(Date.parse(`${item.day}T00:00:00.000Z`) + 86400000).toISOString(),
        indexRoot,
        physicalIdentity: IDENTITY,
        footerCache: createObservationHistoryV3FooterCache(),
        collectWorkloadDiagnostics: true,
      });
      assert.equal(result.response_complete, true);
      assert.equal(result.rows.length, item.rows);
      assert.ok(result.rows.every((row) => row.timeseries_id === item.ts));
      results.push({
        cap_rows: cap,
        day_utc: item.day,
        connector_id: item.connector,
        timeseries_id: item.ts,
        returned_rows: result.rows.length,
        selected_row_groups: result.diagnostics.row_groups_selected,
        physical_rows_decoded: result.diagnostics.rows_decoded,
        r2_bytes_requested: result.diagnostics.r2_bytes_requested,
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
