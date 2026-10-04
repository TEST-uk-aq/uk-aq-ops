import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  readObservationHistoryExactLeafDailyMetadataV3,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  OBSERVATION_VERIFICATION_LATEST_KEY,
  buildObservationVerificationConnectorArtifact,
  buildObservationVerificationConnectorManifest,
  buildObservationVerificationLatest,
  encodeObservationVerificationJson,
  verificationPeriodsFromObservationEvidence,
} from "../workers/shared/uk_aq_observation_verification_overlay.mjs";
import worker, {
  deriveAurnDailyValidationStatus,
  observationHistoryV3ReaderIndex,
  parseDailyProvenanceRequest,
} from "../workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs";

const TIMESERIES_ID = 7421;
const DAY_UTC = "2026-01-02";
const INDEX_ROOT = "history/_index_v3/observations_timeseries";
const encoder = new TextEncoder();

function exactArrayBuffer(value) {
  const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function rows() {
  return [
    {
      connector_id: 1,
      station_id: 7001,
      timeseries_id: TIMESERIES_ID,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T01:00:00.000Z`,
      value: 10,
      verification_status: "R",
    },
    {
      connector_id: 1,
      station_id: 7001,
      timeseries_id: TIMESERIES_ID,
      pollutant_code: "pm25",
      observed_at_utc: `${DAY_UTC}T23:00:00.000Z`,
      value: 11,
      verification_status: "P",
    },
  ];
}

function partition() {
  return buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: rows(),
    targetWriterGitSha: "1".repeat(40),
    backedUpAtUtc: "2026-01-03T00:00:00.000Z",
  });
}

function indexBodies(prepared = partition()) {
  return new Map(prepared.v3_hierarchy.publication_objects.map((artifact) => [
    artifact.key,
    Buffer.from(artifact.body, "utf8"),
  ]));
}

function indexSource(bodies, calls = []) {
  return {
    async getIndexObject({ key, maxBytes }) {
      calls.push({ key, maxBytes });
      const body = bodies.get(key);
      if (!body) return null;
      assert.ok(body.byteLength <= maxBytes);
      return { key, body: exactArrayBuffer(body), byte_size: body.byteLength };
    },
  };
}

function metadataRequest(source, overrides = {}) {
  return readObservationHistoryExactLeafDailyMetadataV3({
    source,
    timeseriesId: TIMESERIES_ID,
    connectorId: 1,
    pollutantCode: "pm25",
    startUtc: `${DAY_UTC}T00:00:00.000Z`,
    endUtc: "2026-01-03T00:00:00.000Z",
    index: observationHistoryV3ReaderIndex(INDEX_ROOT),
    ...overrides,
  });
}

function rewriteManifest(bodies, mutate) {
  const key = `${INDEX_ROOT}/day_utc=${DAY_UTC}/connector_id=1/pollutant_code=pm25/manifest.json`;
  const payload = JSON.parse(bodies.get(key).toString("utf8"));
  mutate(payload.leaves_by_timeseries_id[String(TIMESERIES_ID)]);
  bodies.set(key, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
}

function authority({ defaultStatus = "R", periods = [] } = {}) {
  return {
    overlay_authoritative: true,
    connector_id: 1,
    manifest: {
      timeseries: [{
        connector_id: 1,
        timeseries_id: TIMESERIES_ID,
        source_verification_model: "per-observation-status-v1",
        default_status: defaultStatus,
        periods,
      }],
    },
  };
}

function dailyStatus(authorityValue) {
  return deriveAurnDailyValidationStatus({
    authority: authorityValue,
    timeseriesId: TIMESERIES_ID,
    minObservedAtUtc: `${DAY_UTC}T01:00:00.000Z`,
    maxObservedAtUtc: `${DAY_UTC}T23:00:00.000Z`,
  });
}

function r2Object(value) {
  const body = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  return {
    size: body.byteLength,
    body,
    async arrayBuffer() {
      return exactArrayBuffer(body);
    },
  };
}

async function overlayArtifacts(evidence) {
  const status = verificationPeriodsFromObservationEvidence(evidence, {
    semanticSourceProvenance: { fixture: "daily-provenance-v3" },
  });
  const manifest = buildObservationVerificationConnectorManifest({
    connectorId: 1,
    semanticSourceIdentity: { fixture: "daily-provenance-v3" },
    timeseries: [{
      connector_id: 1,
      station_id: 7001,
      timeseries_id: TIMESERIES_ID,
      pollutant_code: "pm25",
      ...status,
    }],
  });
  const connector = await buildObservationVerificationConnectorArtifact(manifest);
  const latest = buildObservationVerificationLatest({ connectorManifests: [{
    connector_id: 1,
    key: connector.key,
    byte_size: connector.byte_size,
    sha256: connector.sha256,
  }] });
  return { connector, latest };
}

function dailyRequest() {
  return new Request(
    "https://example.test/v1/daily-validation-provenance" +
      `?timeseries_id=${TIMESERIES_ID}&connector_id=1&pollutant=pm25` +
      `&start_utc=${DAY_UTC}T00:00:00.000Z&end_utc=2026-01-03T00:00:00.000Z`,
    { headers: { "x-uk-aq-upstream-auth": "test-secret" } },
  );
}

async function withWorkerHarness(objects, callback) {
  const originalCaches = globalThis.caches;
  const calls = { get: [], head: 0, put: 0 };
  globalThis.caches = { default: { async match() { return null; }, async put() {} } };
  const bucket = {
    async get(key) {
      calls.get.push(key);
      return objects.get(key) || null;
    },
    async head() {
      calls.head += 1;
      throw new Error("Parquet must not be opened by daily provenance");
    },
    async put() {
      calls.put += 1;
      throw new Error("daily provenance must not publish");
    },
  };
  try {
    return await callback({
      calls,
      env: {
        UK_AQ_EDGE_UPSTREAM_SECRET: "test-secret",
        UK_AQ_R2_HISTORY_VERSION: "v3",
        UK_AQ_HISTORY_BUCKET: bucket,
      },
    });
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test("daily metadata accepts current steady-state exact leaves without Parquet access", async () => {
  const prepared = partition();
  const calls = [];
  const result = await metadataRequest(indexSource(indexBodies(prepared), calls));
  assert.deepEqual(result.rows, [{
    day_utc: DAY_UTC,
    row_count: 2,
    min_observed_at_utc: `${DAY_UTC}T01:00:00.000Z`,
    max_observed_at_utc: `${DAY_UTC}T23:00:00.000Z`,
  }]);
  assert.equal(result.diagnostics.parquet_objects_opened, 0);
  assert.equal(calls.length, 2);
  assert.equal(prepared.target_metadata.history_schema_version, 3);
  assert.equal(prepared.target_metadata.writer_version, "parquet-wasm-zstd-v3");
  assert.equal(prepared.target_metadata.observation_content_hash_contract_version, 1);
});

test("daily metadata fails closed on exact-leaf size and SHA mismatch", async () => {
  const wrongSize = indexBodies();
  rewriteManifest(wrongSize, (descriptor) => { descriptor[1] += 1; });
  await assert.rejects(metadataRequest(indexSource(wrongSize)), /byte-size identity mismatch/);

  const wrongSha = indexBodies();
  rewriteManifest(wrongSha, (descriptor) => { descriptor[2] = "0".repeat(64); });
  await assert.rejects(metadataRequest(indexSource(wrongSha)), /SHA-256 identity mismatch/);
});

test("missing day and authoritative timeseries absence produce no provenance row", async () => {
  assert.deepEqual((await metadataRequest(indexSource(new Map()))).rows, []);
  assert.deepEqual((await metadataRequest(indexSource(indexBodies()), {
    timeseriesId: TIMESERIES_ID + 1,
  })).rows, []);
});

test("AURN daily status uses first-observation state and later P starts only", () => {
  assert.equal(dailyStatus(authority({ defaultStatus: "P" })), "P");
  assert.equal(dailyStatus(authority({ periods: [{
    from_observed_at_utc: `${DAY_UTC}T12:00:00.000Z`,
    to_observed_at_utc: null,
    status: "P",
  }] })), "P");
  assert.equal(dailyStatus(authority()), "R");
  assert.equal(dailyStatus(authority({ periods: [{
    from_observed_at_utc: "2026-01-01T00:00:00.000Z",
    to_observed_at_utc: `${DAY_UTC}T00:30:00.000Z`,
    status: "P",
  }] })), "R");
});

test("daily provenance loads authoritative overlay first, reads exact leaves, and never publishes", async () => {
  const prepared = partition();
  const verification = await overlayArtifacts([
    { observed_at_utc: `${DAY_UTC}T00:00:00.000Z`, status: "R" },
    { observed_at_utc: `${DAY_UTC}T12:00:00.000Z`, status: "P" },
  ]);
  const objects = new Map([...indexBodies(prepared)].map(([key, body]) => [key, r2Object(body)]));
  objects.set(verification.connector.key, r2Object(verification.connector.body));
  objects.set(OBSERVATION_VERIFICATION_LATEST_KEY, r2Object(encodeObservationVerificationJson(verification.latest)));
  await withWorkerHarness(objects, async ({ calls, env }) => {
    const response = await worker.fetch(dailyRequest(), env, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const payload = await response.json();
    assert.deepEqual(payload.rows, [{ day_utc: DAY_UTC, source_validation_status: "P" }]);
    assert.deepEqual(calls.get.slice(0, 2), [
      OBSERVATION_VERIFICATION_LATEST_KEY,
      verification.connector.key,
    ]);
    assert.equal(calls.head, 0);
    assert.equal(calls.put, 0);
  });
});

test("pre-overlay state is explicit and discovery/manifest mismatch is rejected before history", async () => {
  await withWorkerHarness(new Map(), async ({ calls, env }) => {
    const response = await worker.fetch(dailyRequest(), env, {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: false,
      error_code: "verification_overlay_not_authoritative",
      error: "verification_overlay_not_authoritative",
    });
    assert.deepEqual(calls.get, [OBSERVATION_VERIFICATION_LATEST_KEY]);
  });

  const verification = await overlayArtifacts([]);
  const mismatchedLatest = buildObservationVerificationLatest({ connectorManifests: [{
    connector_id: 1,
    key: verification.connector.key,
    byte_size: verification.connector.byte_size + 1,
    sha256: verification.connector.sha256,
  }] });
  const objects = new Map([
    [OBSERVATION_VERIFICATION_LATEST_KEY, r2Object(encodeObservationVerificationJson(mismatchedLatest))],
    [verification.connector.key, r2Object(verification.connector.body)],
  ]);
  await withWorkerHarness(objects, async ({ calls, env }) => {
    const response = await worker.fetch(dailyRequest(), env, {});
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match((await response.json()).error, /identity mismatch/);
    assert.equal(calls.get.some((key) => key.startsWith(`${INDEX_ROOT}/day_utc=`)), false);
  });
});

test("366-day provenance range stays inside bounded metadata-only discovery", async () => {
  const calls = [];
  const result = await metadataRequest(indexSource(new Map(), calls), {
    startUtc: "2025-01-01T00:00:00.000Z",
    endUtc: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.diagnostics.utc_scopes_considered, 366);
  assert.equal(result.diagnostics.index_objects_read, 366);
  assert.equal(calls.length, 366);
  assert.equal(parseDailyProvenanceRequest(new URL(
    "https://example.test/v1/daily-validation-provenance" +
      `?timeseries_id=${TIMESERIES_ID}&connector_id=1&pollutant=pm25` +
      "&start_utc=2025-01-01T00:00:00.000Z&end_utc=2026-01-02T00:00:00.000Z",
  )).ok, true);
});

test("active Worker no longer calls the retired reader and observations keep exact-leaf cursors", () => {
  const source = readFileSync(
    "workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs",
    "utf8",
  );
  assert.doesNotMatch(source, /readObservationHistoryExactV3\(/);
  assert.match(source, /readObservationHistoryExactLeafDailyMetadataV3\(/);
  assert.match(source, /readObservationHistoryExactLeafPageV3\([\s\S]*physicalCursor:/);
});
