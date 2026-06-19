import test from "node:test";
import assert from "node:assert/strict";

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
  const layout = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_READ_VERSION: "v1" }, testUrl());
  assert.equal(layout.readVersion.label, "R2_v1");
  assert.equal(layout.observationsPrefix, "history/v1/observations");
  assert.equal(layout.aqilevelsPrefix, "history/v1/aqilevels/hourly");
  assert.equal(buildR2HistoryReadIndexKey(layout, "observations"), "history/_index/observations_latest.json");
  assert.equal(buildR2HistoryReadIndexKey(layout, "aqilevels"), "history/_index/aqilevels_latest.json");
});

test("R2 history calendar resolver maps v2 to v2 timeseries indexes and day prefixes", () => {
  const layout = resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_READ_VERSION: "v2" }, testUrl());
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
    UK_AQ_R2_HISTORY_READ_VERSION: "v1",
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
    () => resolveR2HistoryLayoutConfig({ UK_AQ_R2_HISTORY_READ_VERSION: "v3" }, testUrl()),
    /Invalid R2 history read version "v3"; expected v1 or v2/,
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
