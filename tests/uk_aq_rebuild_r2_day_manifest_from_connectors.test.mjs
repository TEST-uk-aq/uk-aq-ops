import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  buildDayManifestFromConnectorManifests,
} from "../scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs";

function hashWithoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...withoutHash } = payload;
  return sha256Hex(JSON.stringify(withoutHash));
}

test("buildDayManifestFromConnectorManifests rebuilds observations day manifest from connector manifests", () => {
  const existingDayManifest = {
    day_utc: "2026-04-30",
    connector_ids: [1],
    run_id: "existing-day-run",
    writer_git_sha: "abc123",
    backed_up_at_utc: "2026-05-20T20:00:20.000Z",
    manifest_hash: "old",
  };
  const connectorManifests = [
    {
      day_utc: "2026-04-30",
      connector_id: 7,
      run_id: "connector-run-7",
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
      source_row_count: 200,
      min_observed_at: "2026-04-30T00:05:00.000Z",
      max_observed_at: "2026-04-30T23:55:00.000Z",
      parquet_object_keys: ["history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet"],
      file_count: 1,
      total_bytes: 2000,
      files: [
        {
          key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
          bytes: 2000,
          row_count: 200,
          etag_or_hash: "etag-7",
          min_timeseries_id: 701,
          max_timeseries_id: 799,
          min_observed_at: "2026-04-30T00:05:00.000Z",
          max_observed_at: "2026-04-30T23:55:00.000Z",
        },
      ],
      backed_up_at_utc: "2026-05-20T21:00:00.000Z",
    },
    {
      day_utc: "2026-04-30",
      connector_id: 3,
      run_id: "connector-run-3",
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 50,
      min_observed_at: "2026-04-30T01:00:00.000Z",
      max_observed_at: "2026-04-30T22:00:00.000Z",
      parquet_object_keys: ["history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet"],
      file_count: 1,
      total_bytes: 500,
      files: [
        {
          key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
          bytes: 500,
          row_count: 50,
          etag_or_hash: "etag-3",
          min_timeseries_id: 301,
          max_timeseries_id: 399,
          min_observed_at: "2026-04-30T01:00:00.000Z",
          max_observed_at: "2026-04-30T22:00:00.000Z",
        },
      ],
      backed_up_at_utc: "2026-05-20T22:00:00.000Z",
    },
  ];

  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: "observations",
    dayUtc: "2026-04-30",
    connectorManifests,
    existingDayManifest,
  });

  assert.deepEqual(rebuilt.connector_ids, [3, 7]);
  assert.equal(rebuilt.run_id, "existing-day-run");
  assert.equal(rebuilt.source_row_count, 250);
  assert.equal(rebuilt.file_count, 2);
  assert.equal(rebuilt.total_bytes, 2500);
  assert.equal(rebuilt.min_observed_at, "2026-04-30T00:05:00.000Z");
  assert.equal(rebuilt.max_observed_at, "2026-04-30T23:55:00.000Z");
  assert.equal(rebuilt.backed_up_at_utc, "2026-05-20T22:00:00.000Z");
  assert.deepEqual(rebuilt.parquet_object_keys, [
    "history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
    "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
  ]);
  assert.deepEqual(rebuilt.connector_manifests, [
    {
      connector_id: 3,
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 50,
      file_count: 1,
      total_bytes: 500,
    },
    {
      connector_id: 7,
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
      source_row_count: 200,
      file_count: 1,
      total_bytes: 2000,
    },
  ]);
  assert.equal(rebuilt.history_schema_name, "observations");
  assert.equal(rebuilt.history_schema_version, 2);
  assert.equal(rebuilt.writer_version, "parquet-wasm-zstd-v2");
  assert.equal(rebuilt.writer_git_sha, "abc123");
  assert.equal(rebuilt.manifest_hash, hashWithoutManifestHash(rebuilt));
});

test("buildDayManifestFromConnectorManifests keeps aqilevels connector summary fields", () => {
  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: "aqilevels",
    dayUtc: "2026-04-30",
    connectorManifests: [
      {
        day_utc: "2026-04-30",
        connector_id: 3,
        run_id: "shared-run",
        manifest_key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/manifest.json",
        source_row_count: 24,
        min_timeseries_id: 301,
        max_timeseries_id: 350,
        min_timestamp_hour_utc: "2026-04-30T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-04-30T23:00:00.000Z",
        file_count: 1,
        total_bytes: 1200,
        available_pollutants: ["no2", "pm10"],
        files: [
          {
            key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
            bytes: 1200,
            row_count: 24,
            etag_or_hash: "etag-aqi-3",
            pollutant_codes: ["no2", "pm10"],
            min_timeseries_id: 301,
            max_timeseries_id: 350,
            min_timestamp_hour_utc: "2026-04-30T00:00:00.000Z",
            max_timestamp_hour_utc: "2026-04-30T23:00:00.000Z",
          },
        ],
        backed_up_at_utc: "2026-05-01T01:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(rebuilt.connector_ids, [3]);
  assert.equal(rebuilt.run_id, "shared-run");
  assert.equal(rebuilt.min_timeseries_id, 301);
  assert.equal(rebuilt.max_timeseries_id, 350);
  assert.equal(rebuilt.min_timestamp_hour_utc, "2026-04-30T00:00:00.000Z");
  assert.equal(rebuilt.max_timestamp_hour_utc, "2026-04-30T23:00:00.000Z");
  assert.deepEqual(rebuilt.files[0].pollutant_codes, ["no2", "pm10"]);
  assert.deepEqual(rebuilt.connector_manifests, [
    {
      connector_id: 3,
      manifest_key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 24,
      min_timeseries_id: 301,
      max_timeseries_id: 350,
      file_count: 1,
      total_bytes: 1200,
      available_pollutants: ["no2", "pm10"],
    },
  ]);
  assert.equal(rebuilt.grain, "hourly");
  assert.equal(rebuilt.history_schema_name, "aqilevels_hourly");
  assert.equal(rebuilt.history_schema_version, 1);
  assert.equal(rebuilt.writer_version, "parquet-wasm-zstd-v1");
  assert.deepEqual(rebuilt.available_pollutants, ["no2", "pm10"]);
  assert.equal(rebuilt.manifest_hash, hashWithoutManifestHash(rebuilt));
});
