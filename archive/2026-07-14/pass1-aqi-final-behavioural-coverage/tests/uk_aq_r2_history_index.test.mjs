import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryV2TimeseriesLatestPayload,
  buildHistoryV2TimeseriesMetadataIndexPayload,
  buildHistoryV2TimeseriesPollutantIndexPayload,
  buildR2HistoryObservationsTimeseriesConnectorIndexKey,
  buildR2HistoryObservationsTimeseriesLatestKey,
  buildR2HistoryV2TimeseriesMetadataIndexKey,
  buildR2HistoryV2AqilevelsHourlyDataTimeseriesLatestKey,
  buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey,
  buildR2HistoryV2ObservationsTimeseriesLatestKey,
  buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey,
  buildDaySummaryFromManifest,
  buildDomainIndexPayload,
  normalizeR2HistoryIndexDomain,
  normalizeObservationPropertyCode,
  normalizeAqiPollutantCode,
  rebuildR2HistoryV2TimeseriesMetadataIndexes,
  resolveR2HistoryIndexConfig,
  updateR2HistoryIndexesTargeted,
} from "../workers/shared/uk_aq_r2_history_index.mjs";
import {
  main as runHistoryIndexBuildCommand,
  runHistoryIndexBuild,
} from "../scripts/backup_r2/uk_aq_build_r2_history_index.mjs";

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

test("resolveR2HistoryIndexConfig uses the explicit R2 bucket", () => {
  const config = resolveR2HistoryIndexConfig({
    CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
    CFLARE_R2_ENDPOINT: "https://example.invalid",
    CFLARE_R2_ACCESS_KEY_ID: "key",
    CFLARE_R2_SECRET_ACCESS_KEY: "secret",
  });

  assert.equal(config.r2.bucket, "uk-aq-history-cic-test");
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
    CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
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
  assert.equal(
    buildR2HistoryV2TimeseriesMetadataIndexKey("history/_index_v2/timeseries", 3742),
    "history/_index_v2/timeseries/timeseries_id=3742.json",
  );
});

test("v2 observation property codes accept canonical all-pollutant values and reject unsafe paths", () => {
  for (const code of [
    "pm25", "pm10", "no2", "o3", "so2", "co", "no", "nox_as_no2",
    "pm25index", "pm10index", "no2index", "oc6h4ch32", "_o3",
    "123c6h3ch33", "124c6h3ch33", "135c6h3ch33",
  ]) {
    assert.equal(normalizeObservationPropertyCode(code), code);
  }
  for (const value of ["", " ", "../a", "a/b", "a\\b", "a=b", "a%2fb", "a.b", "o 3", "."]) {
    assert.equal(normalizeObservationPropertyCode(value), null);
  }
  assert.equal(normalizeAqiPollutantCode("o3"), null);
  assert.equal(normalizeAqiPollutantCode("PM25"), "pm25");
  assert.equal(
    buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
      "history/_index_v2/observations_timeseries", "2026-05-17", 1, "o3",
    ),
    "history/_index_v2/observations_timeseries/day_utc=2026-05-17/connector_id=1/pollutant_code=o3/manifest.json",
  );
  assert.throws(() => buildR2HistoryV2AqilevelsHourlyDataTimeseriesPollutantIndexKey(
    "history/_index_v2/aqilevels_hourly_data_timeseries", "2026-05-17", 1, "o3",
  ));
});

test("digit-leading observation codes remain in v2 index manifest payloads", () => {
  for (const code of ["123c6h3ch33", "124c6h3ch33", "135c6h3ch33"]) {
    const manifestKey =
      `history/v2/observations/day_utc=2026-07-01/connector_id=7/pollutant_code=${code}/manifest.json`;
    const partKey =
      `history/v2/observations/day_utc=2026-07-01/connector_id=7/pollutant_code=${code}/part-00000.parquet`;
    const payload = buildHistoryV2TimeseriesPollutantIndexPayload({
      domain: "observations",
      dayUtc: "2026-07-01",
      connectorId: 7,
      pollutantCode: code,
      generatedAt: "2026-07-02T00:00:00.000Z",
      bucket: "uk-aq-history-dev",
      dataPrefix: "history/v2/observations",
      pollutantManifestKey: manifestKey,
      pollutantManifest: {
        pollutant_code: code,
        source_row_count: 1,
        timeseries_row_counts: { "101": 1 },
        backed_up_at_utc: "2026-07-02T00:00:00.000Z",
        files: [{
          key: partKey,
          row_count: 1,
          bytes: 100,
          pollutant_code: code,
          min_timeseries_id: 101,
          max_timeseries_id: 101,
          min_observed_at_utc: "2026-07-01T00:00:00.000Z",
          max_observed_at_utc: "2026-07-01T00:00:00.000Z",
        }],
      },
    });

    assert.equal(
      buildR2HistoryV2ObservationsTimeseriesPollutantIndexKey(
        "history/_index_v2/observations_timeseries",
        "2026-07-01",
        7,
        code,
      ),
      `history/_index_v2/observations_timeseries/day_utc=2026-07-01/connector_id=7/pollutant_code=${code}/manifest.json`,
    );
    assert.equal(payload.pollutant_code, code);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].pollutant_code, code);
    assert.equal(payload.files[0].key, partKey);
  }
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

  assert.equal(payload.schema_version, 3);
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

test("targeted v2 AQI index warns when non-empty pollutant manifest lacks usable timeseries counts", async () => {
  const objects = {
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/manifest.json": {
      connector_manifests: [
        {
          connector_id: 6,
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json": {
      connector_id: 6,
      pollutant_manifests: [
        {
          pollutant_code: "no2",
          manifest_key:
            "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json": {
      manifest_hash: "hash-aqi-no2",
      source_row_count: 24,
      row_count: 24,
      backed_up_at_utc: "2026-06-02T00:00:00.000Z",
      files: [
        {
          key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
          row_count: 24,
          bytes: 2222,
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
          min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
          max_timestamp_hour_utc: "2026-06-01T23:00:00.000Z",
        },
      ],
    },
  };
  const fake = installFakeR2Fetch(objects);
  try {
    const summary = await updateR2HistoryIndexesTargeted({
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "test-bucket",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
      historyVersion: "v2",
      domains: ["aqilevels"],
      fromDayUtc: "2026-06-01",
      toDayUtc: "2026-06-01",
      connectorId: 6,
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    const warnings = summary.aqilevels_timeseries.warnings.join("\n");
    assert.match(warnings, /Missing usable timeseries_row_counts in v2 AQI pollutant manifest/);
    assert.match(warnings, /manifest_key=history\/v2\/aqilevels\/hourly\/data\/day_utc=2026-06-01\/connector_id=6\/pollutant_code=no2\/manifest\.json/);
    assert.match(warnings, /day_utc=2026-06-01/);
    assert.match(warnings, /connector_id=6/);
    assert.match(warnings, /pollutant_code=no2/);
    assert.match(warnings, /source_row_count=24/);
    assert.match(warnings, /--compute-missing-timeseries-counts/);
    assert.equal(summary.history_version, "v2");
    assert.equal(summary.index_prefix, "history/_index_v2");
    assert.equal(summary.timeseries_metadata.index_kind, "timeseries_metadata");
  } finally {
    fake.restore();
  }
});

test("targeted v2 AQI index update refreshes timeseries metadata from rewritten indexes", async () => {
  const objects = {
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/manifest.json": {
      connector_manifests: [
        {
          connector_id: 6,
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json": {
      connector_id: 6,
      pollutant_manifests: [
        {
          pollutant_code: "no2",
          manifest_key:
            "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json": {
      manifest_hash: "hash-aqi-no2",
      source_row_count: 24,
      row_count: 24,
      timeseries_row_counts: { "1001": 24 },
      backed_up_at_utc: "2026-06-02T00:00:00.000Z",
      files: [
        {
          key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
          row_count: 24,
          bytes: 2222,
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
          min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
          max_timestamp_hour_utc: "2026-06-01T23:00:00.000Z",
        },
      ],
    },
  };
  const fake = installFakeR2Fetch(objects);
  try {
    const summary = await updateR2HistoryIndexesTargeted({
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "test-bucket",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
      historyVersion: "v2",
      domains: ["aqilevels"],
      fromDayUtc: "2026-06-01",
      toDayUtc: "2026-06-01",
      connectorId: 6,
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    assert.equal(summary.timeseries_metadata.timeseries_count, 1);
    assert.equal(summary.timeseries_metadata.metadata_object_count, 1);
    assert.equal(summary.timeseries_metadata.aqilevels.actual_index_manifest_count, 1);
    const metadataRaw = fake.puts.get("history/_index_v2/timeseries/timeseries_id=1001.json");
    assert.ok(metadataRaw, "targeted v2 update writes the timeseries metadata object");
    const metadata = JSON.parse(metadataRaw);
    assert.equal(metadata.aqi_coverage.row_count, 24);
    assert.equal(metadata.aqi_coverage.first_timestamp_hour_utc, "2026-06-01T00:00:00.000Z");
    assert.equal(metadata.aqi_coverage.last_timestamp_hour_utc, "2026-06-01T23:00:00.000Z");
  } finally {
    fake.restore();
  }
});

test("targeted v2 AQI index strict mode fails when non-empty pollutant manifest lacks usable timeseries counts", async () => {
  const objects = {
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/manifest.json": {
      connector_manifests: [
        {
          connector_id: 6,
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json": {
      connector_id: 6,
      pollutant_manifests: [
        {
          pollutant_code: "no2",
          manifest_key:
            "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json": {
      source_row_count: 24,
      row_count: 24,
      files: [
        {
          key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
          row_count: 24,
          bytes: 2222,
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
        },
      ],
    },
  };
  const fake = installFakeR2Fetch(objects);
  try {
    await assert.rejects(
      updateR2HistoryIndexesTargeted({
        env: {
          CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
          CFLARE_R2_BUCKET: "test-bucket",
          CFLARE_R2_ACCESS_KEY_ID: "key",
          CFLARE_R2_SECRET_ACCESS_KEY: "secret",
        },
        historyVersion: "v2",
        domains: ["aqilevels"],
        fromDayUtc: "2026-06-01",
        toDayUtc: "2026-06-01",
        connectorId: 6,
        strictMissingTimeseriesCounts: true,
      }),
      /Missing usable timeseries_row_counts in v2 AQI pollutant manifest/,
    );
  } finally {
    fake.restore();
  }
});

test("runHistoryIndexBuild dry-run stays read only and reports planned repair sections", async () => {
  const objects = {
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/manifest.json": {
      connector_manifests: [
        {
          connector_id: 6,
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json": {
      connector_id: 6,
      pollutant_manifests: [
        {
          pollutant_code: "no2",
          manifest_key:
            "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json": {
      manifest_hash: "hash-aqi-no2",
      source_row_count: 24,
      row_count: 24,
      timeseries_row_counts: { "1001": 24 },
      backed_up_at_utc: "2026-06-02T00:00:00.000Z",
      files: [
        {
          key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
          row_count: 24,
          bytes: 2222,
          min_timeseries_id: 1001,
          max_timeseries_id: 1001,
          min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
          max_timestamp_hour_utc: "2026-06-01T23:00:00.000Z",
        },
      ],
    },
  };
  const fake = installFakeR2Fetch(objects);
  try {
    const payload = await runHistoryIndexBuild({
      argv: [
        "--history-version",
        "v2",
        "--targeted",
        "--domain",
        "aqilevels",
        "--from-day",
        "2026-06-01",
        "--to-day",
        "2026-06-01",
        "--connector-id",
        "6",
        "--dry-run",
      ],
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
    });

    assert.equal(payload.status, "planned");
    assert.equal(payload.write_r2, false);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.repair.planning.status, "planned");
    assert.equal(payload.repair.execution.status, "planned");
    assert.equal(payload.repair.verification.status, "not_run");
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
  }
});

test("generic index builder permits an explicitly gated configured environment bucket", async () => {
  const fake = installFakeR2Fetch({});
  try {
    const output = await runHistoryIndexBuild({
      argv: ["--history-version", "v2", "--write-r2"],
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "uk-aq-history-dev",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
    });
    assert.equal(output.write_r2, true);
    assert.notEqual(output.status, "planned");
    assert.ok(fake.puts.size > 0);
  } finally {
    fake.restore();
  }
});

test("Phase 7 blocked generic index work returns ok=false and its command exits non-zero", async () => {
  const output = await runHistoryIndexBuild({
    argv: ["--history-version", "v2"],
    rebuildIndexes: async () => ({ blocked_dependency_count: 1 }),
  });
  assert.equal(output.ok, false);
  assert.equal(output.status, "blocked_dependency");

  let printed = "";
  const exitCode = await runHistoryIndexBuildCommand({
    run: async () => output,
    stdout: { write: (value) => { printed += value; } },
  });
  assert.equal(exitCode, 1);
  assert.match(printed, /"ok": false/);
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

test("v2 observations latest day summaries include sorted connector row counts", () => {
  const payload = buildHistoryV2TimeseriesLatestPayload({
    domain: "observations",
    bucket: "uk-aq-history-dev",
    generatedAt: "2026-06-20T00:00:00.000Z",
    dataPrefix: "history/v2/observations",
    timeseriesIndexPrefix: "history/_index_v2/observations_timeseries",
    daySummaries: [
      {
        day_utc: "2026-06-12",
        connector_count: 3,
        connector_ids: [7, 3, 1],
        connectors: [
          { connector_id: 7, row_count: 23456 },
          { connector_id: 1, row_count: 12345 },
          { connector_id: 3, row_count: 67890 },
        ],
        pollutant_codes: ["pm25", "no2"],
        pollutant_index_count: 4,
        file_count: 87,
        indexed_file_count: 87,
        backed_up_at_utc: "2026-06-17T09:52:53.000Z",
      },
    ],
  });

  assert.equal(payload.schema_version, 3);
  assert.equal(payload.domain, "observations");
  assert.equal(payload.total_rows, 103691);
  assert.equal(payload.day_summaries[0].total_rows, 103691);
  assert.deepEqual(payload.day_summaries[0].connector_ids, [1, 3, 7]);
  assert.deepEqual(payload.day_summaries[0].connectors, [
    { connector_id: 1, row_count: 12345 },
    { connector_id: 3, row_count: 67890 },
    { connector_id: 7, row_count: 23456 },
  ]);
  assert.deepEqual(payload.day_summaries[0].pollutant_codes, ["no2", "pm25"]);
  assert.equal(payload.day_summaries[0].file_count, 87);
  assert.equal(payload.day_summaries[0].indexed_file_count, 87);
  assert.equal(payload.day_summaries[0].backed_up_at_utc, "2026-06-17T09:52:53.000Z");
});

test("v2 AQI latest day summaries include connector row counts without using file counts", () => {
  const payload = buildHistoryV2TimeseriesLatestPayload({
    domain: "aqilevels",
    grain: "hourly",
    profile: "data",
    bucket: "uk-aq-history-dev",
    generatedAt: "2026-06-20T00:00:00.000Z",
    dataPrefix: "history/v2/aqilevels/hourly/data",
    timeseriesIndexPrefix: "history/_index_v2/aqilevels_hourly_data_timeseries",
    daySummaries: [
      {
        day_utc: "2026-06-12",
        connector_ids: [3],
        connectors: [{ connector_id: 3, row_count: 2468 }],
        pollutant_codes: ["no2"],
        pollutant_index_count: 1,
        file_count: 1,
        indexed_file_count: 1,
        backed_up_at_utc: "2026-06-17T09:52:53.000Z",
      },
    ],
  });

  assert.equal(payload.schema_version, 3);
  assert.equal(payload.domain, "aqilevels");
  assert.equal(payload.grain, "hourly");
  assert.equal(payload.profile, "data");
  assert.equal(payload.total_rows, 2468);
  assert.equal(payload.day_summaries[0].total_rows, 2468);
  assert.equal(payload.day_summaries[0].file_count, 1);
  assert.deepEqual(payload.day_summaries[0].connectors, [
    { connector_id: 3, row_count: 2468 },
  ]);
});

test("v2 latest payload is byte-stable with unchanged source summaries", () => {
  const args = {
    domain: "observations",
    bucket: "uk-aq-history-dev",
    dataPrefix: "history/v2/observations",
    timeseriesIndexPrefix: "history/_index_v2/observations_timeseries",
    daySummaries: [
      {
        day_utc: "2026-06-12",
        connector_ids: [3, 1],
        connectors: [
          { connector_id: 3, row_count: 30 },
          { connector_id: 1, row_count: 10 },
        ],
        pollutant_codes: ["pm25"],
        pollutant_index_count: 2,
        backed_up_at_utc: "2026-06-17T09:52:53.000Z",
      },
    ],
  };
  const first = JSON.stringify(buildHistoryV2TimeseriesLatestPayload({
    ...args,
    generatedAt: "2026-06-20T00:00:00.000Z",
  }));
  const second = JSON.stringify(buildHistoryV2TimeseriesLatestPayload({
    ...args,
    generatedAt: "2026-06-21T00:00:00.000Z",
  }));

  assert.equal(first, second);
});

test("buildHistoryV2TimeseriesMetadataIndexPayload merges observations and AQI coverage", () => {
  const payload = buildHistoryV2TimeseriesMetadataIndexPayload({
    timeseriesId: 3742,
    generatedAt: "2026-06-18T10:00:00.000Z",
    entries: [
      {
        domain: "observations",
        day_utc: "2026-06-05",
        connector_id: 6,
        pollutant_code: "pm25",
        row_count: 24,
        min_observed_at_utc: "2026-06-05T00:00:00.000Z",
        max_observed_at_utc: "2026-06-05T23:00:00.000Z",
        source_index_key: "history/_index_v2/observations_timeseries/day_utc=2026-06-05/connector_id=6/pollutant_code=pm25/manifest.json",
        source_manifest_hash: "obs-hash",
        backed_up_at_utc: "2026-06-15T11:26:10.267Z",
      },
      {
        domain: "aqilevels",
        day_utc: "2026-06-05",
        connector_id: 6,
        pollutant_code: "pm25",
        row_count: 24,
        min_timestamp_hour_utc: "2026-06-05T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-05T23:00:00.000Z",
        source_index_key: "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-06-05/connector_id=6/pollutant_code=pm25/manifest.json",
        source_manifest_hash: "aqi-hash",
        backed_up_at_utc: "2026-06-15T11:26:11.267Z",
      },
    ],
  });

  assert.equal(payload.index_kind, "timeseries_metadata");
  assert.equal(payload.generated_at, "2026-06-15T11:26:11.267Z");
  assert.equal(payload.connector_id, 6);
  assert.deepEqual(payload.connector_ids, [6]);
  assert.deepEqual(payload.pollutant_codes, ["pm25"]);
  assert.equal(payload.observations_coverage.row_count, 24);
  assert.equal(payload.observations_coverage.first_observed_at_utc, "2026-06-05T00:00:00.000Z");
  assert.equal(payload.aqi_coverage.row_count, 24);
  assert.equal(payload.aqi_coverage.first_timestamp_hour_utc, "2026-06-05T00:00:00.000Z");
});

test("v2 timeseries metadata payload is byte-stable when source timestamps are unchanged", () => {
  const args = {
    timeseriesId: 3742,
    entries: [
      {
        domain: "observations",
        day_utc: "2026-06-05",
        connector_id: 6,
        pollutant_code: "pm25",
        row_count: 24,
        backed_up_at_utc: "2026-06-15T11:26:10.267Z",
      },
    ],
  };
  const first = JSON.stringify(buildHistoryV2TimeseriesMetadataIndexPayload({
    ...args,
    generatedAt: "2026-06-18T10:00:00.000Z",
  }));
  const second = JSON.stringify(buildHistoryV2TimeseriesMetadataIndexPayload({
    ...args,
    generatedAt: "2026-06-18T11:00:00.000Z",
  }));
  assert.equal(first, second);
});

function installFakeR2Fetch(objectsByKey) {
  const originalFetch = globalThis.fetch;
  const puts = new Map();
  function keyFromUrl(url) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const firstSlash = path.indexOf("/");
    if (firstSlash > 0 && !path.startsWith("history/")) {
      return path.slice(firstSlash + 1);
    }
    return path;
  }
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsed = new URL(String(url));
    if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const objectPrefix = parsed.searchParams.get("prefix") || "";
      const keys = [...new Set([...Object.keys(objectsByKey), ...puts.keys()])]
        .filter((candidate) => candidate.startsWith(objectPrefix))
        .sort((left, right) => left.localeCompare(right));
      return new Response(
        `<ListBucketResult>${keys.map((candidate) => `<Contents><Key>${candidate}</Key><Size>1</Size></Contents>`).join("")}</ListBucketResult>`,
        { status: 200 },
      );
    }
    const key = keyFromUrl(String(url));
    if (method === "GET") {
      if (puts.has(key)) {
        return new Response(puts.get(key), {
          status: 200,
          headers: { etag: `"put-${key.length.toString(16)}"` },
        });
      }
      if (!Object.prototype.hasOwnProperty.call(objectsByKey, key)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(`${JSON.stringify(objectsByKey[key])}\n`, {
        status: 200,
        headers: { etag: `"${key.length.toString(16)}"` },
      });
    }
    if (method === "HEAD") {
      return new Response(null, { status: 404 });
    }
    if (method === "PUT") {
      puts.set(key, String(init.body || ""));
      return new Response("", { status: 200, headers: { etag: `"put-${puts.size}"` } });
    }
    return new Response("unsupported", { status: 405 });
  };
  return {
    puts,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("v2 timeseries metadata rebuild skips absent connector pollutant partitions without warnings", async () => {
  const objects = {
    "history/_index_v2/observations_timeseries_latest.json": {
      day_summaries: [
        {
          day_utc: "2026-03-18",
          connector_ids: [3],
          pollutant_codes: ["no2", "pm10", "pm25"],
        },
      ],
    },
    "history/v2/observations/day_utc=2026-03-18/manifest.json": {
      connector_manifests: [
        {
          connector_id: 3,
          manifest_key: "history/v2/observations/day_utc=2026-03-18/connector_id=3/manifest.json",
        },
      ],
    },
    "history/v2/observations/day_utc=2026-03-18/connector_id=3/manifest.json": {
      pollutant_manifests: [
        {
          pollutant_code: "no2",
          manifest_key: "history/v2/observations/day_utc=2026-03-18/connector_id=3/pollutant_code=no2/manifest.json",
        },
        {
          pollutant_code: "pm25",
          manifest_key: "history/v2/observations/day_utc=2026-03-18/connector_id=3/pollutant_code=pm25/manifest.json",
        },
      ],
    },
    "history/v2/observations/day_utc=2026-03-18/connector_id=3/pollutant_code=no2/manifest.json": {
      manifest_hash: "obs-no2",
      backed_up_at_utc: "2026-03-19T00:00:00.000Z",
    },
    "history/v2/observations/day_utc=2026-03-18/connector_id=3/pollutant_code=pm25/manifest.json": {
      manifest_hash: "obs-pm25",
      backed_up_at_utc: "2026-03-19T00:00:00.000Z",
    },
    "history/_index_v2/observations_timeseries/day_utc=2026-03-18/connector_id=3/pollutant_code=no2/manifest.json": {
      domain: "observations",
      day_utc: "2026-03-18",
      connector_id: 3,
      pollutant_code: "no2",
      timeseries_row_counts: { "3001": 24 },
      backed_up_at_utc: "2026-03-19T00:00:00.000Z",
    },
    "history/_index_v2/observations_timeseries/day_utc=2026-03-18/connector_id=3/pollutant_code=pm25/manifest.json": {
      domain: "observations",
      day_utc: "2026-03-18",
      connector_id: 3,
      pollutant_code: "pm25",
      timeseries_row_counts: { "3742": 24 },
      backed_up_at_utc: "2026-03-19T00:00:00.000Z",
    },
    "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json": {
      day_summaries: [
        {
          day_utc: "2026-06-12",
          connector_ids: [7],
          pollutant_codes: ["no2", "pm10", "pm25"],
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/manifest.json": {
      connector_manifests: [
        {
          connector_id: 7,
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/manifest.json": {
      pollutant_manifests: [
        {
          pollutant_code: "pm10",
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/pollutant_code=pm10/manifest.json",
        },
        {
          pollutant_code: "pm25",
          manifest_key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/pollutant_code=pm25/manifest.json",
        },
      ],
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/pollutant_code=pm10/manifest.json": {
      manifest_hash: "aqi-pm10",
      backed_up_at_utc: "2026-06-13T00:00:00.000Z",
    },
    "history/v2/aqilevels/hourly/data/day_utc=2026-06-12/connector_id=7/pollutant_code=pm25/manifest.json": {
      manifest_hash: "aqi-pm25",
      backed_up_at_utc: "2026-06-13T00:00:00.000Z",
    },
    "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-06-12/connector_id=7/pollutant_code=pm10/manifest.json": {
      domain: "aqilevels",
      day_utc: "2026-06-12",
      connector_id: 7,
      pollutant_code: "pm10",
      timeseries_row_counts: { "7001": 24 },
      backed_up_at_utc: "2026-06-13T00:00:00.000Z",
    },
    "history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=2026-06-12/connector_id=7/pollutant_code=pm25/manifest.json": {
      domain: "aqilevels",
      day_utc: "2026-06-12",
      connector_id: 7,
      pollutant_code: "pm25",
      timeseries_row_counts: { "7002": 24 },
      backed_up_at_utc: "2026-06-13T00:00:00.000Z",
    },
  };
  const fakeFetch = installFakeR2Fetch(objects);
  try {
    const summary = await rebuildR2HistoryV2TimeseriesMetadataIndexes({
      r2: {
        endpoint: "https://r2.example.test",
        bucket: "test-bucket",
        region: "auto",
        access_key_id: "test-key",
        secret_access_key: "test-secret",
      },
      bucketName: "test-bucket",
      fetchConcurrency: 4,
    });

    assert.equal(summary.warning_count, 0);
    assert.equal(summary.actual_index_manifest_count, 4);
    assert.equal(summary.metadata_object_count, 4);
    assert.equal(summary.skipped_absent_data_partition_count, 2);
    assert.equal(summary.missing_index_for_existing_data_partition_count, 0);
    assert.equal(summary.observations.actual_index_manifest_count, 2);
    assert.equal(summary.observations.skipped_absent_data_partition_count, 1);
    assert.equal(summary.aqilevels.actual_index_manifest_count, 2);
    assert.equal(summary.aqilevels.skipped_absent_data_partition_count, 1);
    assert.equal(
      summary.warnings.some((warning) => warning.includes("pollutant_code=pm10")),
      false,
    );
    assert.ok(fakeFetch.puts.has("history/_index_v2/timeseries/timeseries_id=3742.json"));
  } finally {
    fakeFetch.restore();
  }
});
