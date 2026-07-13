import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  buildHistoryV2ConnectorManifestForTest,
  buildHistoryV2DayManifestForTest,
  buildHistoryV2PollutantManifestForTest,
} from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const DAY = "2026-06-13";
const BACKED_UP_AT_UTC = "2026-06-15T00:00:00.000Z";
const WRITER_GIT_SHA = "test-sha";
const BASE_PREFIX = "history/v2/observations";

function hashWithoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...withoutHash } = payload;
  return sha256Hex(JSON.stringify(withoutHash));
}

function partKey(dayUtc, connectorId, pollutantCode, partIndex) {
  return `${BASE_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/part-${String(partIndex).padStart(5, "0")}.parquet`;
}

function pollutantManifestKey(dayUtc, connectorId, pollutantCode) {
  return `${BASE_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}/pollutant_code=${pollutantCode}/manifest.json`;
}

function buildPollutantManifest({
  dayUtc,
  connectorId,
  pollutantCode,
  fileEntries,
}) {
  return buildHistoryV2PollutantManifestForTest({
    domain: "observations",
    dayUtc,
    connectorId,
    pollutantCode,
    runId: "test-run",
    manifestKey: pollutantManifestKey(dayUtc, connectorId, pollutantCode),
    sourceRowCount: fileEntries.reduce((sum, entry) => sum + Number(entry.row_count || 0), 0),
    fileEntries,
    writerGitSha: WRITER_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
}

function buildConnectorManifest({ dayUtc, connectorId, pollutantManifests }) {
  return buildHistoryV2ConnectorManifestForTest({
    domain: "observations",
    dayUtc,
    connectorId,
    runId: "test-run",
    manifestKey: `${BASE_PREFIX}/day_utc=${dayUtc}/connector_id=${connectorId}/manifest.json`,
    pollutantManifests,
    writerGitSha: WRITER_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
}

function buildDayManifest({ dayUtc, connectorManifests }) {
  return buildHistoryV2DayManifestForTest({
    domain: "observations",
    dayUtc,
    runId: "test-run",
    manifestKey: `${BASE_PREFIX}/day_utc=${dayUtc}/manifest.json`,
    connectorManifests,
    writerGitSha: WRITER_GIT_SHA,
    backedUpAtUtc: BACKED_UP_AT_UTC,
  });
}

test("Phase B v2 pollutant manifests sort files and remain byte-stable", () => {
  const pollutantManifestArgs = {
    dayUtc: DAY,
    connectorId: 6,
    pollutantCode: "pm25",
    fileEntries: [
      {
        key: partKey(DAY, 6, "pm25", 1),
        row_count: 1,
        bytes: 20,
        etag_or_hash: "etag-1",
        min_timeseries_id: 102,
        max_timeseries_id: 102,
        min_observed_at_utc: "2026-06-13T01:00:00.000Z",
        max_observed_at_utc: "2026-06-13T01:00:00.000Z",
        timeseries_row_counts: { "102": 1 },
      },
      {
        key: partKey(DAY, 6, "pm25", 0),
        row_count: 2,
        bytes: 10,
        etag_or_hash: "etag-0",
        min_timeseries_id: 101,
        max_timeseries_id: 101,
        min_observed_at_utc: "2026-06-13T00:00:00.000Z",
        max_observed_at_utc: "2026-06-13T00:00:00.000Z",
        timeseries_row_counts: { "101": 2 },
      },
    ],
  };

  const first = buildPollutantManifest(pollutantManifestArgs);
  const second = buildPollutantManifest(pollutantManifestArgs);

  assert.deepEqual(first.files.map((entry) => entry.key), [
    partKey(DAY, 6, "pm25", 0),
    partKey(DAY, 6, "pm25", 1),
  ]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.manifest_hash, hashWithoutManifestHash(first));
});

test("Phase B v2 connector manifests sort child pollutant manifests and remain byte-stable", () => {
  const no2Manifest = buildPollutantManifest({
    dayUtc: DAY,
    connectorId: 6,
    pollutantCode: "no2",
    fileEntries: [
      {
        key: partKey(DAY, 6, "no2", 0),
        row_count: 1,
        bytes: 30,
        etag_or_hash: "etag-no2",
        min_timeseries_id: 201,
        max_timeseries_id: 201,
        min_observed_at_utc: "2026-06-13T00:00:00.000Z",
        max_observed_at_utc: "2026-06-13T00:00:00.000Z",
        timeseries_row_counts: { "201": 1 },
      },
    ],
  });
  const pm25Manifest = buildPollutantManifest({
    dayUtc: DAY,
    connectorId: 6,
    pollutantCode: "pm25",
    fileEntries: [
      {
        key: partKey(DAY, 6, "pm25", 0),
        row_count: 2,
        bytes: 10,
        etag_or_hash: "etag-pm25",
        min_timeseries_id: 101,
        max_timeseries_id: 102,
        min_observed_at_utc: "2026-06-13T00:00:00.000Z",
        max_observed_at_utc: "2026-06-13T01:00:00.000Z",
        timeseries_row_counts: { "101": 1, "102": 1 },
      },
    ],
  });

  const first = buildConnectorManifest({
    dayUtc: DAY,
    connectorId: 6,
    pollutantManifests: [pm25Manifest, no2Manifest],
  });
  const second = buildConnectorManifest({
    dayUtc: DAY,
    connectorId: 6,
    pollutantManifests: [pm25Manifest, no2Manifest],
  });

  assert.deepEqual(first.child_manifests.map((entry) => entry.pollutant_code), ["no2", "pm25"]);
  assert.deepEqual(first.files.map((entry) => entry.key), [
    partKey(DAY, 6, "no2", 0),
    partKey(DAY, 6, "pm25", 0),
  ]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.manifest_hash, hashWithoutManifestHash(first));
});

test("Phase B v2 day manifests sort child connector manifests and remain byte-stable", () => {
  const connector7 = buildConnectorManifest({
    dayUtc: DAY,
    connectorId: 7,
    pollutantManifests: [
      buildPollutantManifest({
        dayUtc: DAY,
        connectorId: 7,
        pollutantCode: "pm25",
        fileEntries: [
          {
            key: partKey(DAY, 7, "pm25", 0),
            row_count: 1,
            bytes: 11,
            etag_or_hash: "etag-7-pm25",
            min_timeseries_id: 301,
            max_timeseries_id: 301,
            min_observed_at_utc: "2026-06-13T00:00:00.000Z",
            max_observed_at_utc: "2026-06-13T00:00:00.000Z",
            timeseries_row_counts: { "301": 1 },
          },
        ],
      }),
    ],
  });
  const connector3 = buildConnectorManifest({
    dayUtc: DAY,
    connectorId: 3,
    pollutantManifests: [
      buildPollutantManifest({
        dayUtc: DAY,
        connectorId: 3,
        pollutantCode: "no2",
        fileEntries: [
          {
            key: partKey(DAY, 3, "no2", 0),
            row_count: 1,
            bytes: 12,
            etag_or_hash: "etag-3-no2",
            min_timeseries_id: 401,
            max_timeseries_id: 401,
            min_observed_at_utc: "2026-06-13T00:00:00.000Z",
            max_observed_at_utc: "2026-06-13T00:00:00.000Z",
            timeseries_row_counts: { "401": 1 },
          },
        ],
      }),
    ],
  });

  const first = buildDayManifest({
    dayUtc: DAY,
    connectorManifests: [connector7, connector3],
  });
  const second = buildDayManifest({
    dayUtc: DAY,
    connectorManifests: [connector7, connector3],
  });

  assert.deepEqual(first.child_manifests.map((entry) => entry.connector_id), [3, 7]);
  assert.deepEqual(first.connector_ids, [3, 7]);
  assert.deepEqual(first.files.map((entry) => entry.key), [
    partKey(DAY, 3, "no2", 0),
    partKey(DAY, 7, "pm25", 0),
  ]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.manifest_hash, hashWithoutManifestHash(first));
});
