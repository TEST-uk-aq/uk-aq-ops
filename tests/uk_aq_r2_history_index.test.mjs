import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryV2TimeseriesPollutantIndexPayload,
  buildR2HistoryObservationsTimeseriesConnectorIndexKey,
  buildR2HistoryObservationsTimeseriesLatestKey,
  buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey,
  buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey,
  buildR2HistoryV2ObservationsTimeseriesLatestKey,
  buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey,
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
    prefix: "history/v1/aqilevels/hourly",
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

test("buildDomainIndexPayload derives generated_at from latest day-summary backed_up_at_utc", () => {
  const payload = buildDomainIndexPayload({
    domain: "observations",
    prefix: "history/v1/observations",
    bucket: "uk-aq-history-dev",
    generatedAt: "2026-05-17T12:00:00.000Z",
    daySummaries: [
      {
        day_utc: "2026-03-10",
        total_rows: 20,
        backed_up_at_utc: "2026-03-10T08:00:00.000Z",
      },
      {
        day_utc: "2026-03-12",
        total_rows: 30,
        backed_up_at_utc: "2026-03-13T04:50:02.685Z",
      },
      {
        day_utc: "2026-01-15",
        total_rows: 10,
        backed_up_at_utc: "2026-01-15T22:00:00.000Z",
      },
    ],
  });

  assert.equal(payload.generated_at, "2026-03-13T04:50:02.685Z");
});

test("buildDomainIndexPayload falls back to generatedAt when no source backed_up_at_utc available", () => {
  const payload = buildDomainIndexPayload({
    domain: "observations",
    prefix: "history/v1/observations",
    bucket: "uk-aq-history-dev",
    generatedAt: "2026-05-17T12:00:00.000Z",
    daySummaries: [
      { day_utc: "2026-03-10", total_rows: 20 },
      { day_utc: "2026-03-12", total_rows: 30, backed_up_at_utc: null },
    ],
  });

  assert.equal(payload.generated_at, "2026-05-17T12:00:00.000Z");
});

test("buildDomainIndexPayload is byte-stable across repeated calls with same source data", () => {
  const args = {
    domain: "aqilevels",
    prefix: "history/v1/aqilevels/hourly",
    bucket: "uk-aq-history-dev",
    daySummaries: [
      { day_utc: "2026-03-12", total_rows: 5, backed_up_at_utc: "2026-03-12T01:00:00.000Z" },
    ],
  };
  const first = JSON.stringify(buildDomainIndexPayload({ ...args, generatedAt: "2026-05-17T10:00:00.000Z" }));
  const second = JSON.stringify(buildDomainIndexPayload({ ...args, generatedAt: "2026-05-17T15:30:00.000Z" }));

  assert.equal(first, second);
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

test("resolveR2HistoryIndexConfig exposes v2 data and _index_v2 defaults separately from v1", () => {
  const config = resolveR2HistoryIndexConfig({
    UK_AQ_DEPLOY_ENV: "dev",
    R2_BUCKET_DEV: "uk-aq-history-dev",
    CFLARE_R2_ENDPOINT: "https://example.invalid",
    CFLARE_R2_ACCESS_KEY_ID: "key",
    CFLARE_R2_SECRET_ACCESS_KEY: "secret",
  });

  assert.equal(config.observations_prefix, "history/v1/observations");
  assert.equal(config.aqilevels_prefix, "history/v1/aqilevels/hourly");
  assert.equal(config.index_prefix, "history/_index");
  assert.equal(config.observations_prefix_v2, "history/v2/observations");
  assert.equal(config.aqilevels_hourly_data_prefix_v2, "history/v2/aqilevels/hourly/data");
  assert.equal(config.index_prefix_v2, "history/_index_v2");
  assert.equal(
    config.observations_timeseries_index_prefix_v2,
    "history/_index_v2/observations_timeseries",
  );
  assert.equal(
    config.aqilevels_hourly_data_timeseries_index_prefix_v2,
    "history/_index_v2/aqilevels_hourly_data_timeseries",
  );
});

test("v2 timeseries index keys include day, connector, and pollutant without altering v1 layout", () => {
  assert.equal(
    buildR2HistoryV2ObservationsTimeseriesLatestKey("history/_index_v2"),
    "history/_index_v2/observations_timeseries_latest.json",
  );
  assert.equal(
    buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey("history/_index_v2"),
    "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json",
  );
  assert.equal(
    buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      "history/_index_v2/observations_timeseries",
      "2026-04-03",
      396,
      "PM25",
    ),
    "history/_index_v2/observations_timeseries/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json",
  );
  assert.equal(
    buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
      "history/_index_v2/aqilevels_hourly_data_timeseries",
      "2026-04-03",
      396,
      "pm25",
    ),
    "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json",
  );
});

test("buildHistoryV2TimeseriesPollutantIndexPayload builds observation pollutant index metadata", () => {
  const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
    domain: "observations",
    dayUtc: "2026-04-03",
    connectorId: 396,
    pollutantCode: "pm25",
    generatedAt: "2026-06-01T00:00:00.000Z",
    bucket: "uk-aq-history-dev",
    dataPrefix: "history/v2/observations",
    pollutantManifestKey:
      "history/v2/observations/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json",
    pollutantManifest: {
      manifest_hash: "hash-pm25",
      source_row_count: 15,
      timeseries_row_counts: { "1001": 10, "1002": 5 },
      backed_up_at_utc: "2026-04-04T01:02:03.000Z",
      files: [
        {
          key: "history/v2/observations/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/part-00000.parquet",
          row_count: 15,
          bytes: 12345,
          etag_or_hash: "etag",
          pollutant_code: "pm25",
          min_timeseries_id: 1001,
          max_timeseries_id: 1002,
          min_observed_at_utc: "2026-04-03T00:00:00.000Z",
          max_observed_at_utc: "2026-04-03T23:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(payload.schema_version, 2);
  assert.equal(payload.generated_at, "2026-04-04T01:02:03.000Z");
  assert.equal(payload.history_version, "v2");
  assert.equal(payload.domain, "observations");
  assert.equal(payload.pollutant_code, "pm25");
  assert.equal(payload.index_kind, "timeseries_file_ranges");
  assert.equal(payload.data_prefix, "history/v2/observations");
  assert.equal(payload.source_row_count, 15);
  assert.deepEqual(payload.timeseries_row_counts, { "1001": 10, "1002": 5 });
  assert.equal(payload.file_count, 1);
  assert.equal(payload.indexed_file_count, 1);
  assert.equal(payload.index_coverage, "complete");
  assert.equal(payload.min_timeseries_id, 1001);
  assert.equal(payload.max_timeseries_id, 1002);
  assert.equal(payload.min_observed_at_utc, "2026-04-03T00:00:00.000Z");
  assert.equal(payload.max_observed_at_utc, "2026-04-03T23:00:00.000Z");
  assert.equal(payload.min_timestamp_hour_utc, null);
  assert.equal(payload.files[0].pollutant_code, "pm25");
});

test("buildHistoryV2TimeseriesPollutantIndexPayload builds AQI hourly data pollutant index metadata", () => {
  const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    dayUtc: "2026-04-03",
    connectorId: 396,
    pollutantCode: "pm25",
    generatedAt: "2026-06-01T00:00:00.000Z",
    bucket: "uk-aq-history-dev",
    dataPrefix: "history/v2/aqilevels/hourly/data",
    pollutantManifestKey:
      "history/v2/aqilevels/hourly/data/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json",
    pollutantManifest: {
      manifest_hash: "hash-aqi-pm25",
      row_count: 24,
      backed_up_at_utc: "2026-04-04T02:02:03.000Z",
      files: [
        {
          key: "history/v2/aqilevels/hourly/data/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/part-00000.parquet",
          row_count: 24,
          bytes: 2222,
          pollutant_code: "pm25",
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
          min_timestamp_hour_utc: "2026-04-03T00:00:00.000Z",
          max_timestamp_hour_utc: "2026-04-03T23:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(payload.domain, "aqilevels");
  assert.equal(payload.grain, "hourly");
  assert.equal(payload.profile, "data");
  assert.equal(payload.source_row_count, 24);
  assert.equal(payload.min_observed_at_utc, null);
  assert.equal(payload.max_observed_at_utc, null);
  assert.equal(payload.min_timestamp_hour_utc, "2026-04-03T00:00:00.000Z");
  assert.equal(payload.max_timestamp_hour_utc, "2026-04-03T23:00:00.000Z");
});

test("v2 pollutant index payload is byte-stable when source backed_up_at_utc is unchanged", () => {
  const args = {
    domain: "observations",
    dayUtc: "2026-04-03",
    connectorId: 396,
    pollutantCode: "pm25",
    bucket: "uk-aq-history-dev",
    dataPrefix: "history/v2/observations",
    pollutantManifestKey:
      "history/v2/observations/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/manifest.json",
    pollutantManifest: {
      backed_up_at_utc: "2026-04-04T01:02:03.000Z",
      files: [
        {
          key: "history/v2/observations/day_utc=2026-04-03/connector_id=396/pollutant_code=pm25/part-00000.parquet",
          row_count: 1,
          pollutant_code: "pm25",
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
        },
      ],
    },
  };
  const first = JSON.stringify(buildHistoryV2TimeseriesPollutantIndexPayload({
    ...args,
    generatedAt: "2026-06-01T00:00:00.000Z",
  }));
  const second = JSON.stringify(buildHistoryV2TimeseriesPollutantIndexPayload({
    ...args,
    generatedAt: "2026-06-02T00:00:00.000Z",
  }));

  assert.equal(first, second);
});
