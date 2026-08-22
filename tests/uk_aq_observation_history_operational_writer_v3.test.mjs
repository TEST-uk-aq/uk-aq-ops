import assert from "node:assert/strict";
import test from "node:test";

import {
  createObservationHistoryV3CanonicalConnectorPublisher,
  runDisconnectedPruneDailyObservationHistoryV3Writer,
} from "../workers/shared/uk_aq_observation_history_operational_writer_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  assertAcceptedObservationHistoryWriterLimitsV3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";

const TARGET_GIT_SHA = "2".repeat(40);
const DAY_UTC = "2026-08-18";

function rows(pollutantCode, timeseriesId) {
  return [{
    connector_id: 1,
    station_id: 10,
    timeseries_id: timeseriesId,
    pollutant_code: pollutantCode,
    observed_at_utc: `${DAY_UTC}T00:00:00.000Z`,
    value: 12.5,
    verification_status: null,
  }];
}

test("accepted Phase 6 writer limits are exact and reject drift", () => {
  assert.equal(
    assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
    }),
    ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
  );
  assert.throws(
    () => assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
      max_file_rows: 131071,
    }),
    /max_file_rows must equal the accepted Phase 6 value 131072/,
  );
  assert.throws(
    () => assertAcceptedObservationHistoryWriterLimitsV3({
      ...ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
      tunable_override: 1,
    }),
    /exactly the accepted Phase 6 fields/,
  );
});

test("steady-state preparation represents authoritative empty pollutant scope", () => {
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    scope: {
      day_utc: DAY_UTC,
      connector_id: 1,
      pollutant_code: "o3",
    },
    rows: [],
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  assert.deepEqual(prepared.scope, {
    day_utc: DAY_UTC,
    connector_id: 1,
    pollutant_code: "o3",
  });
  assert.equal(prepared.target_metadata.row_count, 0);
  assert.equal(prepared.file_intents.length, 0);
  assert.equal(prepared.canonical_pollutant_manifest.payload.row_count, 0);
  assert.equal(prepared.v3_hierarchy.child_shards.length, 0);
});

test("connector publisher rereads and preserves unchanged pollutant union", async () => {
  const currentO3 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("o3", 101),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const changedPm25 = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows("pm25", 102),
    targetWriterGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-22T00:00:00.000Z",
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    "history/v2/observations",
    DAY_UTC,
    1,
  );
  const currentConnector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: DAY_UTC,
    connectorId: 1,
    runId: null,
    manifestKey: connectorKey,
    pollutantManifests: [currentO3.canonical_pollutant_manifest.payload],
    writerGitSha: TARGET_GIT_SHA,
    backedUpAtUtc: "2026-08-20T00:00:00.000Z",
  });
  const objects = new Map([
    [
      currentO3.canonical_pollutant_manifest.key,
      Buffer.from(currentO3.canonical_pollutant_manifest.body),
    ],
    [connectorKey, Buffer.from(JSON.stringify(currentConnector, null, 2), "utf8")],
  ]);
  const events = [];
  const publisher = createObservationHistoryV3CanonicalConnectorPublisher({
    targetWriterGitSha: TARGET_GIT_SHA,
    getObject: async ({ key }) => {
      events.push(`get:${key}`);
      return objects.has(key)
        ? { exists: true, body: Buffer.from(objects.get(key)) }
        : { exists: false };
    },
    putIfChanged: async ({ key, body }) => {
      events.push(`put:${key}`);
      objects.set(key, Buffer.from(body));
      return { ok: true, status: "written" };
    },
    recordDurableEvidence: async ({ key }) => {
      events.push(`durable:${key}`);
      return { durable: true };
    },
  });
  const fileEvidence = changedPm25.file_intents.map((intent) => ({
    key: intent.key,
    byte_size: intent.byte_size,
    sha256: intent.sha256,
    verified: true,
    durable: true,
  }));
  const result = await publisher({
    source: "integrity",
    day_utc: DAY_UTC,
    connector_id: 1,
    partitions: [{
      scope: changedPm25.scope,
      target_metadata: changedPm25.target_metadata,
      pollutant_manifest: changedPm25.canonical_pollutant_manifest,
      file_evidence: fileEvidence,
      v3_hierarchy: changedPm25.v3_hierarchy,
    }],
  });

  assert.equal(result.parent_state_reread_under_lock, true);
  assert.deepEqual(result.current_pollutant_codes, ["o3"]);
  assert.deepEqual(result.changed_pollutant_codes, ["pm25"]);
  assert.deepEqual(result.final_pollutant_codes, ["o3", "pm25"]);
  assert.deepEqual(
    result.connector_manifest_payload.pollutant_codes,
    ["o3", "pm25"],
  );
  assert.ok(events.indexOf(`get:${connectorKey}`) < events.indexOf(
    `put:${changedPm25.canonical_pollutant_manifest.key}`,
  ));
  await assert.rejects(
    publisher({
      source: "sos_historical_replacement",
      day_utc: DAY_UTC,
      connector_id: 1,
      partitions: [{
        scope: changedPm25.scope,
        target_metadata: changedPm25.target_metadata,
        pollutant_manifest: changedPm25.canonical_pollutant_manifest,
        file_evidence: fileEvidence,
        v3_hierarchy: changedPm25.v3_hierarchy,
      }],
    }),
    /SOS complete-day replacement found live connector state after deletion/,
  );
});

test("disconnected operational entry point is v3-only", () => {
  assert.throws(
    () => runDisconnectedPruneDailyObservationHistoryV3Writer({
      env: { UK_AQ_R2_HISTORY_INDEX_VERSION: "v2" },
    }),
    /Unsupported observation-history index generation for v3 builder: v2/,
  );
});
