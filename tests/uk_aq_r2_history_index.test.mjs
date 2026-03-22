import test from "node:test";
import assert from "node:assert/strict";
import {
  buildR2HistoryObservationsTimeseriesConnectorIndexKey,
  buildR2HistoryObservationsTimeseriesLatestKey,
  buildDaySummaryFromManifest,
  buildDomainIndexPayload,
  normalizeR2HistoryIndexDomain,
  resolveR2HistoryIndexConfig,
} from "../workers/shared/uk_aq_r2_history_index.mjs";

test("buildDaySummaryFromManifest keeps connector row counts from observations day manifest", () => {
  const summary = buildDaySummaryFromManifest({
    domain: "observations",
    dayUtc: "2026-03-12",
    manifest: {
      day_utc: "2026-03-12",
      source_row_count: 15,
      file_count: 2,
      total_bytes: 2048,
      min_observed_at: "2026-03-12T00:00:00.000Z",
      max_observed_at: "2026-03-12T23:59:00.000Z",
      connector_manifests: [
        {
          connector_id: 6,
          source_row_count: 11,
          file_count: 1,
          total_bytes: 1024,
          manifest_key: "history/v1/observations/day_utc=2026-03-12/connector_id=6/manifest.json",
        },
        {
          connector_id: 7,
          source_row_count: 4,
          file_count: 1,
          total_bytes: 1024,
          manifest_key: "history/v1/observations/day_utc=2026-03-12/connector_id=7/manifest.json",
        },
      ],
    },
  });

  assert.equal(summary.day_utc, "2026-03-12");
  assert.equal(summary.total_rows, 15);
  assert.equal(summary.connector_count, 2);
  assert.equal(summary.file_count, 2);
  assert.equal(summary.total_bytes, 2048);
  assert.deepEqual(summary.connectors, [
    {
      connector_id: 6,
      row_count: 11,
      file_count: 1,
      total_bytes: 1024,
      manifest_key: "history/v1/observations/day_utc=2026-03-12/connector_id=6/manifest.json",
    },
    {
      connector_id: 7,
      row_count: 4,
      file_count: 1,
      total_bytes: 1024,
      manifest_key: "history/v1/observations/day_utc=2026-03-12/connector_id=7/manifest.json",
    },
  ]);
});

test("normalizeR2HistoryIndexDomain filters to lookback window while preserving totals", () => {
  const payload = buildDomainIndexPayload({
    domain: "aqilevels",
    prefix: "history/v1/aqilevels",
    bucket: "uk-aq-history-dev",
    generatedAt: "2026-03-13T12:00:00.000Z",
    daySummaries: [
      {
        day_utc: "2026-01-15",
        total_rows: 10,
        connector_count: 1,
        connectors: [{ connector_id: 6, row_count: 10, file_count: 1, total_bytes: 100 }],
      },
      {
        day_utc: "2026-03-10",
        total_rows: 20,
        connector_count: 1,
        connectors: [{ connector_id: 6, row_count: 20, file_count: 1, total_bytes: 200 }],
      },
      {
        day_utc: "2026-03-12",
        total_rows: 30,
        connector_count: 1,
        connectors: [{ connector_id: 7, row_count: 30, file_count: 1, total_bytes: 300 }],
      },
    ],
  });

  const normalized = normalizeR2HistoryIndexDomain(payload, {
    expectedDomain: "aqilevels",
    maxLookbackDays: 7,
    todayDay: "2026-03-13",
  });

  assert.deepEqual(normalized.days, ["2026-03-10", "2026-03-12"]);
  assert.equal(normalized.min_day_utc, "2026-03-10");
  assert.equal(normalized.max_day_utc, "2026-03-12");
  assert.equal(normalized.day_count, 2);
  assert.equal(normalized.total_rows, 50);
});

test("resolveR2HistoryIndexConfig uses deploy bucket mapping when explicit bucket is absent", () => {
  const config = resolveR2HistoryIndexConfig({
    UK_AQ_DEPLOY_ENV: "stage",
    R2_BUCKET_STAGE: "uk-aq-history-stage",
    CFLARE_R2_ENDPOINT: "https://example.invalid",
    CFLARE_R2_ACCESS_KEY_ID: "key",
    CFLARE_R2_SECRET_ACCESS_KEY: "secret",
  });

  assert.equal(config.deploy_env, "stage");
  assert.equal(config.r2.bucket, "uk-aq-history-stage");
  assert.equal(config.index_prefix, "history/_index");
  assert.equal(
    config.observations_timeseries_index_prefix,
    "history/_index/observations_timeseries",
  );
});

test("observations timeseries index keys follow expected history/_index layout", () => {
  const latestKey = buildR2HistoryObservationsTimeseriesLatestKey("history/_index");
  const connectorKey = buildR2HistoryObservationsTimeseriesConnectorIndexKey(
    "history/_index/observations_timeseries",
    "2026-03-22",
    6,
  );

  assert.equal(latestKey, "history/_index/observations_timeseries_latest.json");
  assert.equal(
    connectorKey,
    "history/_index/observations_timeseries/day_utc=2026-03-22/connector_id=6/manifest.json",
  );
});
