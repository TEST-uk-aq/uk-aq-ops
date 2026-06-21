import test from "node:test";
import assert from "node:assert/strict";

import worker from "../workers/uk_aq_db_size_metrics_api_worker/worker.mjs";
import {
  aggregateR2HistoryConnectorCounts,
  buildR2HistoryCountBuckets,
} from "../workers/uk_aq_db_size_metrics_api_worker/worker.mjs";

test("buildR2HistoryCountBuckets builds monthly bucket ranges from inclusive day window", () => {
  const buckets = buildR2HistoryCountBuckets("2025-01-15", "2025-03-02", "month");

  assert.deepEqual(buckets.orderedBucketKeys, ["2025-01", "2025-02", "2025-03"]);
  assert.deepEqual(buckets.bucketMetaByKey.get("2025-01"), {
    bucket_key: "2025-01",
    bucket_start_day_utc: "2025-01-15",
    bucket_end_day_utc: "2025-01-31",
    calendar_day_count: 17,
  });
  assert.deepEqual(buckets.bucketMetaByKey.get("2025-02"), {
    bucket_key: "2025-02",
    bucket_start_day_utc: "2025-02-01",
    bucket_end_day_utc: "2025-02-28",
    calendar_day_count: 28,
  });
  assert.deepEqual(buckets.bucketMetaByKey.get("2025-03"), {
    bucket_key: "2025-03",
    bucket_start_day_utc: "2025-03-01",
    bucket_end_day_utc: "2025-03-02",
    calendar_day_count: 2,
  });
});

test("aggregateR2HistoryConnectorCounts preserves per-connector daily rows and monthly averages", () => {
  const aggregated = aggregateR2HistoryConnectorCounts({
    observationsDomain: {
      day_summaries: [
        {
          day_utc: "2025-01-15",
          connectors: [
            { connector_id: 1, row_count: 100 },
            { connector_id: 6, row_count: 50 },
          ],
        },
        {
          day_utc: "2025-01-16",
          connectors: [
            { connector_id: 1, row_count: 120 },
          ],
        },
      ],
    },
    aqilevelsDomain: {
      day_summaries: [
        {
          day_utc: "2025-01-15",
          connectors: [
            { connector_id: 1, row_count: 20 },
          ],
        },
        {
          day_utc: "2025-01-16",
          connectors: [
            { connector_id: 1, row_count: 30 },
            { connector_id: 6, row_count: 10 },
          ],
        },
      ],
    },
    fromDay: "2025-01-15",
    toDay: "2025-01-16",
    grain: "day",
  });

  assert.equal(aggregated.bucket_count, 2);
  assert.equal(aggregated.range_day_count, 2);
  assert.deepEqual(aggregated.connectors.map((entry) => entry.connector_id), [1, 6]);

  assert.deepEqual(aggregated.connectors[0].buckets, [
    {
      bucket_key: "2025-01-15",
      bucket_start_day_utc: "2025-01-15",
      bucket_end_day_utc: "2025-01-15",
      calendar_day_count: 1,
      observations_rows: 100,
      observations_present_days: 1,
      observations_avg_rows_per_day: 100,
      aqilevels_rows: 20,
      aqilevels_present_days: 1,
      aqilevels_avg_rows_per_day: 20,
      total_rows: 120,
      total_avg_rows_per_day: 120,
    },
    {
      bucket_key: "2025-01-16",
      bucket_start_day_utc: "2025-01-16",
      bucket_end_day_utc: "2025-01-16",
      calendar_day_count: 1,
      observations_rows: 120,
      observations_present_days: 1,
      observations_avg_rows_per_day: 120,
      aqilevels_rows: 30,
      aqilevels_present_days: 1,
      aqilevels_avg_rows_per_day: 30,
      total_rows: 150,
      total_avg_rows_per_day: 150,
    },
  ]);

  const monthly = aggregateR2HistoryConnectorCounts({
    observationsDomain: {
      day_summaries: [
        { day_utc: "2025-01-01", connectors: [{ connector_id: 1, row_count: 310 }] },
      ],
    },
    aqilevelsDomain: {
      day_summaries: [
        { day_utc: "2025-01-15", connectors: [{ connector_id: 1, row_count: 62 }] },
      ],
    },
    fromDay: "2025-01-01",
    toDay: "2025-01-31",
    grain: "month",
  });

  assert.equal(monthly.connectors.length, 1);
  assert.deepEqual(monthly.connectors[0].buckets, [
    {
      bucket_key: "2025-01",
      bucket_start_day_utc: "2025-01-01",
      bucket_end_day_utc: "2025-01-31",
      calendar_day_count: 31,
      observations_rows: 310,
      observations_present_days: 1,
      observations_avg_rows_per_day: 10,
      aqilevels_rows: 62,
      aqilevels_present_days: 1,
      aqilevels_avg_rows_per_day: 2,
      total_rows: 372,
      total_avg_rows_per_day: 12,
    },
  ]);
});

import {
  buildR2HistoryReadIndexKey,
  compactHistoryIndexDomain,
  resolveR2HistoryLayoutConfig,
} from "../workers/uk_aq_db_size_metrics_api_worker/worker.mjs";

function testUrl(search = "") {
  return new URL(`https://example.test/v1/r2-history-days${search}`);
}

test("R2 history calendar resolver maps v1 to v1 indexes and prefixes", () => {
  const layout = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: "v1" }, testUrl());
  assert.equal(layout.readVersion.label, "R2_v1");
  assert.equal(layout.observationsPrefix, "history/v1/observations");
  assert.equal(layout.aqilevelsPrefix, "history/v1/aqilevels/hourly");
  assert.equal(buildR2HistoryReadIndexKey(layout, "observations"), "history/_index/observations_latest.json");
  assert.equal(buildR2HistoryReadIndexKey(layout, "aqilevels"), "history/_index/aqilevels_latest.json");
});

test("R2 history calendar resolver maps v2 to v2 timeseries indexes and day prefixes", () => {
  const layout = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: "v2" }, testUrl());
  assert.equal(layout.readVersion.label, "R2_v2");
  assert.equal(layout.observationsPrefix, "history/v2/observations");
  assert.equal(layout.aqilevelsPrefix, "history/v2/aqilevels/hourly/data");
  assert.equal(buildR2HistoryReadIndexKey(layout, "observations"), "history/_index_v2/observations_timeseries_latest.json");
  assert.equal(buildR2HistoryReadIndexKey(layout, "aqilevels"), "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json");
  assert.equal(`${layout.observationsPrefix}/day_utc=2026-06-12/`, "history/v2/observations/day_utc=2026-06-12/");
  assert.equal(`${layout.aqilevelsPrefix}/day_utc=2026-06-12/`, "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/");
});

test("R2 history calendar resolver honours explicit v2 env defaults and query labels", () => {
  const layout = resolveR2HistoryLayoutConfig({
    UK_AQ_R2_HISTORY_VERSION: "v1",
    UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX: "custom/v2/obs/",
    UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX: "custom/v2/aqi/",
    UK_AQ_R2_HISTORY_INDEX_V2_PREFIX: "custom/_index_v2/",
  }, testUrl("?read_version=v2"));
  assert.equal(layout.readVersion.source, "query");
  assert.equal(layout.readVersion.label, "R2_v2");
  assert.equal(layout.observationsPrefix, "custom/v2/obs");
  assert.equal(layout.aqilevelsPrefix, "custom/v2/aqi");
  assert.equal(buildR2HistoryReadIndexKey(layout, "observations"), "custom/_index_v2/observations_timeseries_latest.json");
  assert.equal(buildR2HistoryReadIndexKey(layout, "aqilevels"), "custom/_index_v2/aqilevels_hourly_data_timeseries_latest.json");
});

test("invalid R2 history read version gives a clear warning/error", () => {
  assert.throws(
    () => resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_VERSION: "v3" }, testUrl()),
    /Invalid UK_AQ_R2_HISTORY_VERSION="v3"; expected v1 or v2/,
  );
});

test("missing R2 history version gives a clear warning/error", () => {
  assert.throws(
    () => resolveR2HistoryLayoutConfig({}, testUrl()),
    /Missing UK_AQ_R2_HISTORY_VERSION/,
  );
});

test("deprecated split read version is rejected even with canonical env set", () => {
  assert.throws(
    () => resolveR2HistoryLayoutConfig({
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_READ_VERSION: "v2",
    }, testUrl()),
    /UK_AQ_R2_HISTORY_READ_VERSION/,
  );
});

test("calendar day compaction detects v2-only days from day_summaries even without a days array", () => {
  const compacted = compactHistoryIndexDomain({
    day_summaries: [
      { day_utc: "2026-06-14", connectors: [{ connector_id: 1, row_count: 1 }] },
      { day_utc: "2026-06-12", connectors: [{ connector_id: 1, row_count: 1 }] },
      { day_utc: "2026-06-13", connectors: [{ connector_id: 6, row_count: 1 }] },
    ],
  });
  assert.deepEqual(compacted.days, ["2026-06-12", "2026-06-13", "2026-06-14"]);
});

function installFakeR2GetObjects(objectsByKey) {
  const originalFetch = globalThis.fetch;
  function keyFromUrl(url) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const prefix = "test-bucket/";
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const key = keyFromUrl(String(url));
    if (method !== "GET") {
      return new Response("unsupported", { status: 405 });
    }
    if (!Object.prototype.hasOwnProperty.call(objectsByKey, key)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(`${JSON.stringify(objectsByKey[key])}\n`, {
      status: 200,
      headers: { etag: `"${key.length.toString(16)}"` },
    });
  };
  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

const r2Env = {
  CFLARE_R2_BUCKET: "test-bucket",
  CFLARE_R2_ENDPOINT: "https://r2.example.test",
  CFLARE_R2_REGION: "auto",
  CFLARE_R2_ACCESS_KEY_ID: "test-key",
  CFLARE_R2_SECRET_ACCESS_KEY: "test-secret",
};

async function fetchCountsJson(search, objectsByKey, env = {}) {
  const fakeFetch = installFakeR2GetObjects(objectsByKey);
  try {
    const response = await worker.fetch(
      new Request(`https://metrics.example.test/v1/r2-history-counts${search}`),
      { ...r2Env, ...env },
    );
    const payload = await response.json();
    return { status: response.status, payload };
  } finally {
    fakeFetch.restore();
  }
}

function latestIndexPayload(domain, daySummaries, overrides = {}) {
  const days = daySummaries.map((entry) => entry.day_utc).sort();
  return {
    schema_version: overrides.schema_version ?? 3,
    generated_at: overrides.generated_at || "2026-06-19T02:00:58.194Z",
    source: "r2_pollutant_manifests",
    history_version: overrides.history_version || "v2",
    domain,
    index_kind: "timeseries_file_ranges",
    min_day_utc: days[0] || null,
    max_day_utc: days[days.length - 1] || null,
    day_count: days.length,
    total_rows: daySummaries.reduce((sum, entry) => sum + (entry.total_rows || 0), 0),
    days,
    day_summaries: daySummaries,
  };
}

test("v1 counts API behaviour is unchanged for day grain", async () => {
  const objects = {
    "history/_index/observations_latest.json": latestIndexPayload("observations", [
      {
        day_utc: "2026-06-12",
        total_rows: 12,
        connectors: [{ connector_id: 1, row_count: 12 }],
      },
    ], { schema_version: 1, history_version: "v1" }),
    "history/_index/aqilevels_latest.json": latestIndexPayload("aqilevels", [
      {
        day_utc: "2026-06-12",
        total_rows: 4,
        connectors: [{ connector_id: 1, row_count: 4 }],
      },
    ], { schema_version: 1, history_version: "v1" }),
  };

  const { status, payload } = await fetchCountsJson(
    "?read_version=v1&from_day=2026-06-12&to_day=2026-06-12&grain=day",
    objects,
  );

  assert.equal(status, 200);
  assert.equal(payload.read_version, "v1");
  assert.equal(payload.read_version_label, "R2_v1");
  assert.equal(payload.index_keys.observations, "history/_index/observations_latest.json");
  assert.equal(payload.connectors.length, 1);
  assert.equal(payload.connectors[0].observations_total_rows, 12);
  assert.equal(payload.connectors[0].aqilevels_total_rows, 4);
  assert.deepEqual(payload.warnings, []);
});

test("v2 counts API aggregates connector rows from v2 latest index connector summaries", async () => {
  const objects = {
    "history/_index_v2/observations_timeseries_latest.json": latestIndexPayload("observations", [
      {
        day_utc: "2026-06-12",
        connector_ids: [1, 3, 7],
        connectors: [
          { connector_id: 1, row_count: 10 },
          { connector_id: 3, row_count: 30 },
          { connector_id: 7, row_count: 70 },
        ],
        total_rows: 110,
      },
      {
        day_utc: "2026-06-13",
        connector_ids: [1, 3],
        connectors: [
          { connector_id: 1, row_count: 11 },
          { connector_id: 3, row_count: 33 },
        ],
        total_rows: 44,
      },
      {
        day_utc: "2026-06-14",
        connector_ids: [7],
        connectors: [{ connector_id: 7, row_count: 77 }],
        total_rows: 77,
      },
    ]),
    "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json": latestIndexPayload("aqilevels", [
      {
        day_utc: "2026-06-12",
        connector_ids: [1, 3, 7],
        connectors: [
          { connector_id: 1, row_count: 2 },
          { connector_id: 3, row_count: 6 },
          { connector_id: 7, row_count: 14 },
        ],
        total_rows: 22,
      },
      {
        day_utc: "2026-06-13",
        connector_ids: [1],
        connectors: [{ connector_id: 1, row_count: 3 }],
        total_rows: 3,
      },
      {
        day_utc: "2026-06-14",
        connector_ids: [7],
        connectors: [{ connector_id: 7, row_count: 15 }],
        total_rows: 15,
      },
    ], { generated_at: "2026-06-19T14:04:26.841Z" }),
  };

  const { status, payload } = await fetchCountsJson(
    "?read_version=v2&from_day=2026-06-12&to_day=2026-06-14&grain=day",
    objects,
    { UK_AQ_R2_HISTORY_VERSION: "v1" },
  );

  assert.equal(status, 200);
  assert.equal(payload.read_version, "v2");
  assert.equal(payload.read_version_label, "R2_v2");
  assert.equal(payload.source, "cloudflare_r2_history_index");
  assert.deepEqual(payload.warnings, []);
  assert.equal(payload.error, null);
  assert.equal(payload.domains.observations.total_rows, 231);
  assert.equal(payload.domains.aqilevels.total_rows, 40);
  assert.equal(payload.domains.observations.generated_at, "2026-06-19T02:00:58.194Z");
  assert.equal(payload.domains.aqilevels.max_day_utc, "2026-06-14");
  assert.equal(payload.domains.observations.connector_row_counts_found, true);
  assert.ok(payload.domains.observations.first_day_summary_fields.includes("connectors"));
  assert.ok(payload.domains.observations.first_day_summary_fields.includes("total_rows"));
  assert.deepEqual(payload.connectors.map((entry) => entry.connector_id), [1, 3, 7]);
  assert.equal(payload.connectors[0].observations_total_rows, 21);
  assert.equal(payload.connectors[0].aqilevels_total_rows, 5);
  assert.equal(payload.connectors[1].observations_total_rows, 63);
  assert.equal(payload.connectors[1].aqilevels_total_rows, 6);
  assert.equal(payload.connectors[2].observations_total_rows, 147);
  assert.equal(payload.connectors[2].aqilevels_total_rows, 29);
});

test("v2 counts API supports month grain and connector_ids filtering", async () => {
  const objects = {
    "history/_index_v2/observations_timeseries_latest.json": latestIndexPayload("observations", [
      {
        day_utc: "2026-06-12",
        connectors: [
          { connector_id: 1, row_count: 10 },
          { connector_id: 3, row_count: 30 },
        ],
        total_rows: 40,
      },
      {
        day_utc: "2026-06-14",
        connectors: [
          { connector_id: 3, row_count: 33 },
          { connector_id: 7, row_count: 77 },
        ],
        total_rows: 110,
      },
    ]),
    "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json": latestIndexPayload("aqilevels", [
      {
        day_utc: "2026-06-13",
        connectors: [
          { connector_id: 3, row_count: 6 },
          { connector_id: 7, row_count: 14 },
        ],
        total_rows: 20,
      },
    ]),
  };

  const { payload } = await fetchCountsJson(
    "?read_version=v2&from_day=2026-06-12&to_day=2026-06-14&grain=month&connector_ids=3,7",
    objects,
  );

  assert.deepEqual(payload.connectors.map((entry) => entry.connector_id), [3, 7]);
  assert.equal(payload.connectors[0].buckets[0].bucket_key, "2026-06");
  assert.equal(payload.connectors[0].buckets[0].observations_rows, 63);
  assert.equal(payload.connectors[0].buckets[0].aqilevels_rows, 6);
  assert.equal(payload.connectors[1].buckets[0].observations_rows, 77);
  assert.equal(payload.connectors[1].buckets[0].aqilevels_rows, 14);
});

test("old v2 latest index shape warns that connector counts require a rebuild", async () => {
  const objects = {
    "history/_index_v2/observations_timeseries_latest.json": latestIndexPayload("observations", [
      {
        day_utc: "2026-06-12",
        connector_ids: [1, 3, 7],
        connector_count: 3,
        file_count: 87,
        indexed_file_count: 87,
      },
    ], { schema_version: 2 }),
    "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json": latestIndexPayload("aqilevels", [
      {
        day_utc: "2026-06-12",
        connector_ids: [1, 3, 7],
        connector_count: 3,
        file_count: 87,
        indexed_file_count: 87,
      },
    ], { schema_version: 2 }),
  };

  const { status, payload } = await fetchCountsJson(
    "?read_version=v2&from_day=2026-06-12&to_day=2026-06-12&grain=day",
    objects,
  );

  assert.equal(status, 200);
  assert.equal(payload.read_version, "v2");
  assert.equal(payload.connector_count, 0);
  assert.deepEqual(payload.connectors, []);
  assert.equal(payload.domains.observations.connector_array_day_count, 0);
  assert.equal(payload.domains.observations.connector_row_counts_found, false);
  assert.ok(payload.warnings.some((warning) =>
    warning.includes("observations R2_v2 latest index")
    && warning.includes("rebuild the v2 latest index")
  ));
  assert.ok(payload.warnings.some((warning) =>
    warning.includes("aqilevels R2_v2 latest index")
    && warning.includes("rebuild the v2 latest index")
  ));
  assert.equal(payload.index_keys.observations, "history/_index_v2/observations_timeseries_latest.json");
});
