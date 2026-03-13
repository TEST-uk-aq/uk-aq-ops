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
