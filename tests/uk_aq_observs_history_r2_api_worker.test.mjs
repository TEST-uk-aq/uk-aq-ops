import test from "node:test";
import assert from "node:assert/strict";

import observsHistoryWorker from "../workers/uk_aq_observs_history_r2_api_worker/worker.mjs";

function makeJsonR2Object(payload) {
  const text = `${JSON.stringify(payload)}\n`;
  return {
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(text).buffer;
    },
  };
}

function installHarness(objectsByKey = {}) {
  const getKeys = [];
  const cachePutCalls = [];
  const waitUntilPromises = [];
  const originalCaches = globalThis.caches;

  globalThis.caches = {
    default: {
      async match() {
        return null;
      },
      async put(request, response) {
        cachePutCalls.push({ url: request.url, status: response.status });
      },
    },
  };

  return {
    getKeys,
    cachePutCalls,
    env: {
      UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
      UK_AQ_R2_HISTORY_VERSION: "v1",
      UK_AQ_HISTORY_BUCKET: {
        async get(key) {
          getKeys.push(key);
          return objectsByKey[key] || null;
        },
      },
    },
    ctx: {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    },
    async restore() {
      if (originalCaches === undefined) {
        delete globalThis.caches;
      } else {
        globalThis.caches = originalCaches;
      }
      await Promise.allSettled(waitUntilPromises);
    },
  };
}

function observationRequest(extraParams = "") {
  const suffix = extraParams ? `&${extraParams}` : "";
  return new Request(
    "https://example.test/v1/observations?"
      + "timeseries_id=1001&connector_id=396"
      + "&start_utc=2026-04-03T00:00:00.000Z"
      + "&end_utc=2026-04-04T00:00:00.000Z"
      + suffix,
    {
      headers: {
        "x-uk-aq-upstream-auth": "test-upstream-secret",
      },
    },
  );
}

function metadataRequest(timeseriesId = 3742) {
  return new Request(
    `https://example.test/v1/timeseries-metadata?timeseries_id=${timeseriesId}`,
    {
      headers: {
        "x-uk-aq-upstream-auth": "test-upstream-secret",
      },
    },
  );
}

test("observations Worker v1 default uses configured v1 prefix and v1 index", async () => {
  const harness = installHarness({});
  try {
    const response = await observsHistoryWorker.fetch(
      observationRequest(),
      {
        ...harness.env,
        UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX: "history/v1/observations-custom",
        UK_AQ_R2_HISTORY_INDEX_PREFIX: "history/_index_custom",
        UK_AQ_OBSERVS_HISTORY_R2_TIMESERIES_INDEX_PREFIX:
          "history/_index_custom/observations_timeseries",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.read_version, "v1");
    assert.equal(payload.history_prefix, "history/v1/observations-custom");
    assert.equal(payload.coverage.index_version, "v1");
    assert.equal(payload.coverage.timeseries_index.prefix, "history/_index_custom/observations_timeseries");
    assert.ok(
      harness.getKeys.includes(
        "history/_index_custom/observations_timeseries/day_utc=2026-04-03/connector_id=396/manifest.json",
      ),
    );
    assert.ok(
      harness.getKeys.includes(
        "history/v1/observations-custom/day_utc=2026-04-03/manifest.json",
      ),
    );
    assert.equal(harness.getKeys.some((key) => key.includes("history/_index_v2")), false);
    assert.equal(harness.getKeys.some((key) => key.includes("pollutant_code=")), false);
  } finally {
    await harness.restore();
  }
});

test("observations Worker v2 requires pollutant partition and does not broad scan", async () => {
  const harness = installHarness({});
  try {
    const response = await observsHistoryWorker.fetch(
      observationRequest(),
      {
        ...harness.env,
        UK_AQ_R2_HISTORY_VERSION: "v2",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.read_version, "v2");
    assert.equal(payload.response_complete, false);
    assert.equal(payload.coverage.pollutant_partition, null);
    assert.equal(payload.coverage.r2_object_reads, 0);
    assert.equal(harness.getKeys.length, 0);
    assert.ok(payload.coverage.timeseries_index.warnings.some((warning) =>
      warning.includes("pollutant is required")
    ));
  } finally {
    await harness.restore();
  }
});

test("observations Worker v2 reads pollutant index path and reports missing parquet structurally", async () => {
  const indexKey =
    "history/_index_v2/observations_timeseries/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json";
  const parquetKey =
    "history/v2/observations/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/part-00000.parquet";
  const harness = installHarness({
    [indexKey]: makeJsonR2Object({
      files: [
        {
          key: parquetKey,
          row_count: 24,
          pollutant_code: "pm25",
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
          min_observed_at_utc: "2026-04-03T00:00:00.000Z",
          max_observed_at_utc: "2026-04-03T23:00:00.000Z",
        },
      ],
    }),
  });

  try {
    const response = await observsHistoryWorker.fetch(
      observationRequest("pollutant=pm25"),
      {
        ...harness.env,
        UK_AQ_R2_HISTORY_VERSION: "v2",
        UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX: "history/v2/observations",
        UK_AQ_R2_HISTORY_INDEX_V2_PREFIX: "history/_index_v2",
        UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX:
          "history/_index_v2/observations_timeseries",
      },
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.read_version, "v2");
    assert.equal(payload.history_prefix, "history/v2/observations");
    assert.equal(payload.coverage.index_version, "v2");
    assert.equal(payload.coverage.pollutant_partition, "pm25");
    assert.equal(payload.coverage.timeseries_index.hit_count, 1);
    assert.equal(payload.coverage.timeseries_index.miss_count, 0);
    assert.deepEqual(payload.coverage.missing_parquet_keys, [parquetKey]);
    assert.equal(payload.coverage.r2_object_reads, 2);
    assert.equal(payload.coverage.parquet_matched_rows, 0);
    assert.deepEqual(harness.getKeys, [indexKey, parquetKey]);
    assert.equal(harness.getKeys.some((key) => key.includes("history/v1/observations")), false);
  } finally {
    await harness.restore();
  }
});

test("observations Worker serves protected v2 timeseries metadata index", async () => {
  const metadataKey = "history/_index_v2/timeseries/timeseries_id=3742.json";
  const harness = installHarness({
    [metadataKey]: makeJsonR2Object({
      schema_version: 1,
      index_kind: "timeseries_metadata",
      history_version: "v2",
      timeseries_id: 3742,
      connector_id: 6,
      connector_ids: [6],
      pollutant_codes: ["pm25"],
      observations_coverage: { row_count: 10 },
      aqi_coverage: { row_count: 8 },
    }),
  });

  try {
    const response = await observsHistoryWorker.fetch(
      metadataRequest(),
      harness.env,
      harness.ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.metadata_key, metadataKey);
    assert.equal(payload.metadata.connector_id, 6);
    assert.deepEqual(harness.getKeys, [metadataKey]);
  } finally {
    await harness.restore();
  }
});
