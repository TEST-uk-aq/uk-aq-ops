import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUkAirBlackCarbonAnnualUrl,
  parseUkAirBlackCarbonAnnualCsv,
  requiredBlackCarbonAnnualSourceYears,
  routeBlackCarbonSelectedScopes,
} from "../scripts/ukair_bc/uk_air_black_carbon_source.mjs";
import {
  buildBackfillYearRanges,
  parseReconcilerArgs,
  planAnnualSourceRequests,
  resolveBlackCarbonMetadata,
  runBlackCarbonObservationReconciler,
  runLockedReconciliation,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler.mjs";
import {
  currentConnectorManifest,
  mergeSelectedTimeseriesRows,
  readCurrentPollutantState,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler_locked.mjs";
import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2ConnectorManifestKey,
  buildHistoryV2DayManifest,
  buildHistoryV2DayManifestKey,
} from "../workers/shared/uk_aq_r2_history_canonical.mjs";

const TEST_WRITER_GIT_SHA = "2".repeat(40);
const TEST_SCOPE = Object.freeze({
  day_utc: "2026-07-01",
  connector_id: 8,
  pollutant_code: "bc",
});

function blackCarbonCanonicalFixture(rows) {
  const generation = getObservationHistoryGeneration("v3");
  const partition = buildObservationHistoryV3SteadyStatePartition({
    source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation,
    rows,
    scope: TEST_SCOPE,
    targetWriterGitSha: TEST_WRITER_GIT_SHA,
    observationsPrefix: generation.observations_prefix,
    indexRoot: generation.observations_timeseries_index_prefix,
  });
  const connectorKey = buildHistoryV2ConnectorManifestKey(
    generation.observations_prefix,
    TEST_SCOPE.day_utc,
    TEST_SCOPE.connector_id,
  );
  const connector = buildHistoryV2ConnectorManifest({
    domain: "observations",
    dayUtc: TEST_SCOPE.day_utc,
    connectorId: TEST_SCOPE.connector_id,
    manifestKey: connectorKey,
    pollutantManifests: [partition.canonical_pollutant_manifest.payload],
    writerGitSha: TEST_WRITER_GIT_SHA,
    backedUpAtUtc: null,
  });
  const dayKey = buildHistoryV2DayManifestKey(
    generation.observations_prefix,
    TEST_SCOPE.day_utc,
  );
  const day = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: TEST_SCOPE.day_utc,
    manifestKey: dayKey,
    connectorManifests: [connector],
    writerGitSha: TEST_WRITER_GIT_SHA,
    backedUpAtUtc: null,
  });
  return { generation, partition, connectorKey, connector, dayKey, day };
}

function manifestBody(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

function canonicalFixtureObjects(fixture, { day = fixture.day, connector = fixture.connector } = {}) {
  return new Map([
    [fixture.dayKey, manifestBody(day)],
    [fixture.connectorKey, manifestBody(connector)],
    [fixture.partition.canonical_pollutant_manifest.key,
      fixture.partition.canonical_pollutant_manifest.body],
    ...fixture.partition.file_intents.map((intent) => [intent.key, intent.body]),
  ]);
}

function memoryR2(objects) {
  const calls = [];
  const r2 = {
    adapter: {
      headObject: async ({ key }) => {
        calls.push({ operation: "head", key });
        const body = objects.get(key);
        return body === undefined
          ? { exists: false, key }
          : { exists: true, key, bytes: body.byteLength };
      },
      getObject: async ({ key }) => {
        calls.push({ operation: "get", key });
        const body = objects.get(key);
        if (body === undefined) throw new Error(`Unexpected missing test object: ${key}`);
        return { exists: true, key, bytes: body.byteLength, body };
      },
    },
  };
  return { r2, calls };
}

function currentStateArgs(r2, generation) {
  return {
    r2,
    generation,
    scope: TEST_SCOPE,
    dayCache: new Map(),
    connectorCache: new Map(),
    pollutantCache: new Map(),
  };
}

function hourlyDataRow(date, hourlyValues, { provisional = false } = {}) {
  const values = Array(24).fill("");
  for (const [hour, value] of Object.entries(hourlyValues)) {
    values[Number(hour) - 1] = String(value);
  }
  return `${provisional ? "##" : ""}${date},${values.join(",")}`;
}

function annualCsv({
  series = "Black Carbon (880nm)",
  unit = "ug/m-3",
  header = [
    "Date",
    ...Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(2, "0")}:00`),
  ],
  rows = [
    hourlyDataRow("30-06-2026", { 24: 0 }),
    hourlyDataRow("01-07-2026", { 1: 1.25 }, { provisional: true }),
  ],
} = {}) {
  return Buffer.from([
    "Data supplied by UK-AIR on 24/9/2026",
    "All Data GMT hour ending  ",
    "Rows begining ## are Provisional",
    `Shrewsbury Underdale ${series} ${unit}`,
    header.join(","),
    ...rows,
  ].join("\n"), "utf8");
}

test("Black Carbon annual parser preserves GMT boundary, P/R, blank and zero semantics", () => {
  const parsed = parseUkAirBlackCarbonAnnualCsv({
    bytes: annualCsv(),
    sourceProperty: "bc",
    sourceYear: 2026,
    ukAirRef: "UKA01055",
    siteRef: "SHUN",
  });

  assert.deepEqual(parsed.rows, [{
    observed_at_utc: "2026-07-01T00:00:00.000Z",
    value: 0,
    verification_status: "R",
  }, {
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1.25,
    verification_status: "P",
  }]);
  assert.equal(parsed.source_series, "Black Carbon (880 nm)");
  assert.equal(parsed.source_supplied_date, "24/9/2026");
  assert.equal(parsed.source_rows, 2);
  assert.equal(parsed.valid_observation_count, 2);
  assert.equal(parsed.missing_cell_count, 46);
  assert.equal(parsed.provisional_count, 1);
  assert.equal(parsed.ratified_count, 1);
  assert.equal(parsed.zero_count, 1);
  assert.deepEqual(parsed.per_partition_day_row_counts, { "2026-07-01": 2 });
});

test("Black Carbon annual parser fails closed for a contradictory source series", () => {
  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({ series: "UV Particulate Matter (370nm)" }),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /source-property declaration mismatch for bc: uv370/,
  );
  for (const series of [
    "UV Particulate Matter (UV-BC)",
    "Black Carbon (950nm)",
  ]) {
    assert.throws(
      () => parseUkAirBlackCarbonAnnualCsv({
        bytes: annualCsv({ series }),
        sourceProperty: "uv370",
        sourceYear: 2026,
        ukAirRef: "UKA01055",
        siteRef: "SHUN",
      }),
      /source-property declaration mismatch for uv370/,
    );
  }
});

test("Black Carbon annual parser identifies the official UV370 series", () => {
  const parsed = parseUkAirBlackCarbonAnnualCsv({
    bytes: annualCsv({ series: "UV Particulate Matter (370nm)" }),
    sourceProperty: "uv370",
    sourceYear: 2026,
    ukAirRef: "UKA01055",
    siteRef: "SHUN",
  });

  assert.equal(parsed.source_property, "uv370");
  assert.equal(parsed.source_series, "UV Particulate Matter (370 nm)");
  assert.equal(parsed.valid_observation_count, 2);
});

test("Black Carbon annual parser rejects unsupported units and malformed hourly layouts", () => {
  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({ unit: "mg/m-3" }),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /source unit contradicts ug\/m3: mg\/m-3/,
  );

  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({
        header: [
          "Date",
          ...Array.from({ length: 23 }, (_, index) =>
            `${String(index + 1).padStart(2, "0")}:00`
          ),
        ],
      }),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /data header must be Date followed by 01:00 through 24:00/,
  );

  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({
        rows: [`01-07-2026,${Array(23).fill("1").join(",")}`],
      }),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /data row at line 6 must contain 24 hourly cells/,
  );
});

test("Black Carbon annual parser rejects source dates outside the requested year", () => {
  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({ rows: [hourlyDataRow("31-12-2025", { 24: 1 })] }),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /row outside source year 2026/,
  );
});

test("Black Carbon annual routing is exact and year-boundary selection reuses the shared helper", () => {
  assert.equal(
    buildUkAirBlackCarbonAnnualUrl({
      siteRef: "SHUN",
      sourceProperty: "bc",
      sourceYear: 2026,
    }),
    "https://uk-air.defra.gov.uk/datastore/data_files/site_pol_data/SHUN_BC_2026.csv",
  );
  assert.equal(
    buildUkAirBlackCarbonAnnualUrl({
      siteRef: "SHUN",
      sourceProperty: "uv370",
      sourceYear: 2026,
    }),
    "https://uk-air.defra.gov.uk/datastore/data_files/site_pol_data/SHUN_U_Violet_2026.csv",
  );
  assert.deepEqual(
    requiredBlackCarbonAnnualSourceYears(["2020-01-01"]).years,
    [2019, 2020],
  );
});

test("metadata resolution uses ukair_bc identities and the authoritative site_ref bridge", async () => {
  const calls = [];
  const responses = [
    { rows: [{ id: 8, connector_code: "ukair_bc" }] },
    { rows: [{
      station_id: "101",
      uk_air_ref: "UKA01055",
      service_ref: "ukair_bc",
      bridge_uk_air_ref: "UKA01055",
      site_ref: "SHUN",
      raw_payload: {
        supported_properties: ["bc"],
        supporting_files: { bc: ["SHUN_BC_2026.csv"] },
      },
    }] },
    { rows: [{
      timeseries_id: 201,
      station_id: "101",
      connector_id: 8,
      service_ref: "ukair_bc",
      timeseries_ref: "UKA01055:bc",
      uom: "ug/m3",
      pollutant_code: "bc",
    }] },
  ];
  const metadata = await resolveBlackCarbonMetadata({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return responses.shift();
    },
  }, {
    stationRefs: ["UKA01055"],
    properties: ["bc"],
  });

  assert.deepEqual(calls[0].params, ["ukair_bc"]);
  assert.match(calls[1].sql, /uk_aq_raw\.ukair_bc_station_refs/);
  assert.equal(metadata.connector_id, 8);
  const acquisition = planAnnualSourceRequests({
    metadata,
    properties: ["bc"],
    requiredYears: [2026],
  });
  assert.equal(acquisition.requests.length, 1);
  assert.equal(
    acquisition.requests[0].source_url,
    "https://uk-air.defra.gov.uk/datastore/data_files/site_pol_data/SHUN_BC_2026.csv",
  );
});

test("selected scope routing sends rows to replacement, conclusive empty to removal, and blocks failures", () => {
  const canonicalRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 0,
    verification_status: "R",
  };
  const routed = routeBlackCarbonSelectedScopes([{
    day_utc: "2026-07-01",
    connector_id: 8,
    pollutant_code: "bc",
    rows: [canonicalRow],
    conclusive: true,
  }, {
    day_utc: "2026-07-01",
    connector_id: 8,
    pollutant_code: "uv370",
    rows: [],
    conclusive: true,
  }, {
    day_utc: "2026-07-02",
    connector_id: 8,
    pollutant_code: "bc",
    rows: [],
    blocked_reason: "source unavailable",
  }]);

  assert.deepEqual(routed.partitions, [{
    scope: { day_utc: "2026-07-01", connector_id: 8, pollutant_code: "bc" },
    rows: [canonicalRow],
  }]);
  assert.deepEqual(routed.removedScopes, [
    { day_utc: "2026-07-01", connector_id: 8, pollutant_code: "uv370" },
  ]);
  assert.deepEqual(routed.blockedScopes, [{
    day_utc: "2026-07-02",
    connector_id: 8,
    pollutant_code: "bc",
    blocked_reason: "source unavailable",
  }]);
});

test("station-narrowed reconciliation preserves unselected canonical peer rows", () => {
  const common = {
    connector_id: 8,
    station_id: 101,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    verification_status: "R",
  };
  const finalRows = mergeSelectedTimeseriesRows({
    currentRows: [{ ...common, timeseries_id: 201, value: 1 }, {
      ...common,
      station_id: 102,
      timeseries_id: 202,
      value: 2,
    }],
    desiredRows: [],
    selectedTimeseriesIds: [201],
  });

  assert.deepEqual(finalRows, [{
    ...common,
    station_id: 102,
    timeseries_id: 202,
    value: 2,
  }]);
});

test("day authority omission ignores an orphan connector and its unselected station rows", async () => {
  const stationA = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  };
  const stationB = {
    ...stationA,
    station_id: 102,
    timeseries_id: 202,
    value: 2,
  };
  const fixture = blackCarbonCanonicalFixture([stationA, stationB]);
  const emptyDay = buildHistoryV2DayManifest({
    domain: "observations",
    dayUtc: TEST_SCOPE.day_utc,
    manifestKey: fixture.dayKey,
    connectorManifests: [],
    writerGitSha: TEST_WRITER_GIT_SHA,
    backedUpAtUtc: null,
  });
  const { r2, calls } = memoryR2(canonicalFixtureObjects(fixture, { day: emptyDay }));

  const current = await readCurrentPollutantState(
    currentStateArgs(r2, fixture.generation),
  );
  assert.equal(current.connector, null);
  assert.deepEqual(current.rows, []);
  assert.equal(calls.some((call) => call.key === fixture.connectorKey), false);

  const desiredA = { ...stationA, value: 3 };
  assert.deepEqual(mergeSelectedTimeseriesRows({
    currentRows: current.rows,
    desiredRows: [desiredA],
    selectedTimeseriesIds: [stationA.timeseries_id],
  }), [desiredA]);
});

test("day-selected connector identity mismatch fails closed", async () => {
  const selected = blackCarbonCanonicalFixture([{
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  }]);
  const staleBody = blackCarbonCanonicalFixture([{
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 9,
    verification_status: "R",
  }]);
  assert.notEqual(selected.connector.manifest_hash, staleBody.connector.manifest_hash);
  const { r2 } = memoryR2(canonicalFixtureObjects(selected, {
    connector: staleBody.connector,
  }));

  await assert.rejects(
    () => currentConnectorManifest({
      r2,
      generation: selected.generation,
      scope: TEST_SCOPE,
      cache: new Map(),
      dayCache: new Map(),
    }),
    /Canonical day connector identity is stale/,
  );
});

test("valid day-selected connector preserves an unselected station peer", async () => {
  const stationA = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  };
  const stationB = {
    ...stationA,
    station_id: 102,
    timeseries_id: 202,
    value: 2,
  };
  const fixture = blackCarbonCanonicalFixture([stationA, stationB]);
  const { r2 } = memoryR2(canonicalFixtureObjects(fixture));

  const current = await readCurrentPollutantState(
    currentStateArgs(r2, fixture.generation),
  );
  assert.equal(current.connector.manifest_hash, fixture.connector.manifest_hash);
  assert.deepEqual(mergeSelectedTimeseriesRows({
    currentRows: current.rows,
    desiredRows: [{ ...stationA, value: 3 }],
    selectedTimeseriesIds: [stationA.timeseries_id],
  }), [{ ...stationA, value: 3 }, stationB]);
});

test("missing day authority treats the connector as absent without probing its stale object", async () => {
  const fixture = blackCarbonCanonicalFixture([{
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  }]);
  const objects = canonicalFixtureObjects(fixture);
  objects.delete(fixture.dayKey);
  const { r2, calls } = memoryR2(objects);

  const current = await readCurrentPollutantState(
    currentStateArgs(r2, fixture.generation),
  );
  assert.equal(current.connector, null);
  assert.deepEqual(current.rows, []);
  assert.equal(calls.some((call) => call.key === fixture.connectorKey), false);
  assert.deepEqual(calls, [{ operation: "head", key: fixture.dayKey }]);
});

test("the shared selected-scope target writer accepts canonical bc and uv370 rows", () => {
  for (const [index, pollutantCode] of ["bc", "uv370"].entries()) {
    const built = buildObservationHistoryV3SteadyStatePartition({
      source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.selectedScopeReconciliation,
      rows: [{
        connector_id: 8,
        station_id: 101,
        timeseries_id: 201 + index,
        pollutant_code: pollutantCode,
        observed_at_utc: `2026-07-01T0${index + 1}:00:00.000Z`,
        value: index,
        verification_status: index === 0 ? "R" : "P",
      }],
      scope: {
        day_utc: "2026-07-01",
        connector_id: 8,
        pollutant_code: pollutantCode,
      },
      targetWriterGitSha: "2".repeat(40),
    });
    assert.equal(built.scope.pollutant_code, pollutantCode);
    assert.equal(built.target_metadata.row_count, 1);
    assert.deepEqual(built.target_metadata.observation_content_hash_columns, [
      "connector_id",
      "station_id",
      "timeseries_id",
      "pollutant_code",
      "observed_at_utc",
      "value",
      "verification_status",
    ]);
  }
});

test("apply wiring enters the existing global-lock coordinator and protected child", async () => {
  let invocation = null;
  const code = await runLockedReconciliation({
    planPath: "/tmp/ukair-bc-plan.json",
    planSha256: "a".repeat(64),
    runId: "ukair-bc-test-run",
    env: { UKAQ_ENV_NAME: "TEST" },
    spawnImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return 0;
    },
  });

  assert.equal(code, 0);
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /uk_aq_with_observations_global_operation_lock\.mjs$/);
  assert.deepEqual(invocation.args.slice(1, 6), [
    "--owner",
    "ukair_bc_observation_reconciler",
    "--run-id",
    "ukair-bc-test-run",
    "--",
  ]);
  assert.match(invocation.args[7], /uk_aq_ukair_bc_observation_reconciler_locked\.mjs$/);
  assert.equal(invocation.options.env.UKAQ_ENV_NAME, "TEST");
});

test("daily CLI derives a configurable recent horizon without selecting the full backfill", () => {
  const args = parseReconcilerArgs([
    "--mode", "daily",
    "--horizon-days", "3",
    "--property", "bc,uv370",
  ], { now: new Date("2026-09-23T12:00:00.000Z") });
  assert.equal(args.fromDay, "2026-09-20");
  assert.equal(args.toDay, "2026-09-22");
  assert.deepEqual(args.properties, ["bc", "uv370"]);
  assert.equal(args.apply, false);
});

test("backfill year selection starts at 2020 and bounds a partial final year", () => {
  assert.deepEqual(buildBackfillYearRanges("2022-12-31"), [
    { year: 2020, from_day: "2020-01-01", to_day: "2020-12-31" },
    { year: 2021, from_day: "2021-01-01", to_day: "2021-12-31" },
    { year: 2022, from_day: "2022-01-01", to_day: "2022-12-31" },
  ]);
  assert.deepEqual(buildBackfillYearRanges("2026-09-23").at(-1), {
    year: 2026,
    from_day: "2026-01-01",
    to_day: "2026-09-23",
  });
  assert.ok(buildBackfillYearRanges("2026-09-23").every(
    (range) => range.from_day >= "2020-01-01",
  ));
});

function successfulBackfillChildReport(reportPath, overrides = {}) {
  return {
    ok: true,
    report_path: reportPath,
    selected_stations: ["UKA00001"],
    source_files_successfully_pinned: 2,
    failed_blocked_scope_count: 0,
    non_empty_replacement_scope_count: 1,
    explicit_removal_scope_count: 0,
    unchanged_no_op_scope_count: 1,
    r2_changed_scope_count: 0,
    final_status: "dry_run_completed",
    ...overrides,
  };
}

test("backfill dry-run processes bounded years sequentially with identical narrowing", async (t) => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-bc-backfill-dry-"));
  t.after(async () => await fs.rm(evidenceRoot, { recursive: true, force: true }));
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const result = await runBlackCarbonObservationReconciler({
    argv: [
      "--mode", "backfill",
      "--to", "2022-06-30",
      "--station", "UKA00001",
      "--property", "uv370,bc",
      "--dry-run",
      "--download-concurrency", "3",
      "--download-timeout-ms", "45000",
      "--download-retries", "2",
      "--run-id", "backfill-dry-test",
      "--evidence-root", evidenceRoot,
    ],
    env: { UKAQ_ENV_NAME: "TEST" },
    now: new Date("2022-07-01T12:00:00.000Z"),
    clock: () => new Date("2022-07-01T12:01:00.000Z"),
    runBackfillYear: async (input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(input);
      await Promise.resolve();
      active -= 1;
      return {
        code: 0,
        report: successfulBackfillChildReport(input.reportPath),
        report_read_error: null,
      };
    },
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(calls.map((call) => call.range), [
    { year: 2020, from_day: "2020-01-01", to_day: "2020-12-31" },
    { year: 2021, from_day: "2021-01-01", to_day: "2021-12-31" },
    { year: 2022, from_day: "2022-01-01", to_day: "2022-06-30" },
  ]);
  for (const call of calls) {
    assert.deepEqual(call.childArgv.slice(0, 6), [
      "--mode", "range", "--from", call.range.from_day, "--to", call.range.to_day,
    ]);
    assert.ok(call.childArgv.includes("--dry-run"));
    assert.equal(call.childArgv[call.childArgv.indexOf("--station") + 1], "UKA00001");
    assert.equal(call.childArgv[call.childArgv.indexOf("--property") + 1], "bc,uv370");
    assert.equal(call.childArgv[call.childArgv.indexOf("--download-concurrency") + 1], "3");
    assert.equal(call.childArgv[call.childArgv.indexOf("--download-timeout-ms") + 1], "45000");
    assert.equal(call.childArgv[call.childArgv.indexOf("--download-retries") + 1], "2");
  }
  assert.equal(result.report.ok, true);
  assert.deepEqual(result.report.years_completed, [2020, 2021, 2022]);
  assert.deepEqual(result.report.years_failed, []);
  assert.deepEqual(result.report.years_not_attempted, []);
  assert.equal(result.report.current_or_failed_year, null);
});

test("backfill apply starts one independently protected range child per year", async (t) => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-bc-backfill-apply-"));
  t.after(async () => await fs.rm(evidenceRoot, { recursive: true, force: true }));
  const calls = [];
  const result = await runBlackCarbonObservationReconciler({
    argv: [
      "--mode", "backfill",
      "--to", "2021-12-31",
      "--apply",
      "--run-id", "backfill-apply-test",
      "--evidence-root", evidenceRoot,
    ],
    env: { UKAQ_ENV_NAME: "TEST" },
    now: new Date("2022-01-01T12:00:00.000Z"),
    runBackfillYear: async (input) => {
      calls.push(input);
      return {
        code: 0,
        report: successfulBackfillChildReport(input.reportPath, {
          final_status: "protected_r2_phase_completed",
        }),
        report_read_error: null,
      };
    },
  });

  assert.equal(result.report.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.childArgv.includes("--apply")));
  assert.ok(calls.every((call) => call.childArgv[1] === "range"));
  assert.notEqual(calls[0].reportPath, calls[1].reportPath);
  assert.match(calls[0].reportPath, /years\/year-2020\/report\.json$/);
  assert.match(calls[1].reportPath, /years\/year-2021\/report\.json$/);
});

test("backfill failure stops later years and records completed, failed and unattempted state", async (t) => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-bc-backfill-fail-"));
  t.after(async () => await fs.rm(evidenceRoot, { recursive: true, force: true }));
  const attempted = [];
  const result = await runBlackCarbonObservationReconciler({
    argv: [
      "--mode", "backfill",
      "--to", "2022-12-31",
      "--dry-run",
      "--run-id", "backfill-failure-test",
      "--evidence-root", evidenceRoot,
    ],
    env: { UKAQ_ENV_NAME: "TEST" },
    now: new Date("2023-01-01T12:00:00.000Z"),
    runBackfillYear: async (input) => {
      attempted.push(input.year);
      if (input.year === 2021) {
        return {
          code: 1,
          report: successfulBackfillChildReport(input.reportPath, {
            ok: false,
            failed_blocked_scope_count: 1,
            final_status: "dry_run_completed_with_blocked_scopes",
          }),
          report_read_error: null,
        };
      }
      return {
        code: 0,
        report: successfulBackfillChildReport(input.reportPath),
        report_read_error: null,
      };
    },
  });

  assert.deepEqual(attempted, [2020, 2021]);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.final_status, "failed_year_reconciliation");
  assert.deepEqual(result.report.years_completed, [2020]);
  assert.deepEqual(result.report.years_failed, [2021]);
  assert.deepEqual(result.report.years_not_attempted, [2022]);
  assert.equal(result.report.current_or_failed_year, 2021);
  assert.deepEqual(result.report.per_year_results.map((entry) => entry.status), [
    "completed", "failed", "not_attempted",
  ]);
  assert.equal(result.report.per_year_results[0].unchanged_no_op_scope_count, 1);
  assert.equal(result.report.per_year_results[0].r2_changed_scope_count, 0);
  const persisted = JSON.parse(await fs.readFile(result.report.report_path, "utf8"));
  assert.deepEqual(persisted.years_not_attempted, [2022]);
});

test("a new backfill run still attempts an already canonical year and preserves child no-op results", async (t) => {
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-bc-backfill-rerun-"));
  t.after(async () => await fs.rm(evidenceRoot, { recursive: true, force: true }));
  const attempted = [];
  for (const runId of ["backfill-first-run", "backfill-second-run"]) {
    const result = await runBlackCarbonObservationReconciler({
      argv: [
        "--mode", "backfill",
        "--to", "2020-12-31",
        "--apply",
        "--run-id", runId,
        "--evidence-root", evidenceRoot,
      ],
      env: { UKAQ_ENV_NAME: "TEST" },
      now: new Date("2021-01-01T12:00:00.000Z"),
      runBackfillYear: async (input) => {
        attempted.push({ runId, year: input.year });
        return {
          code: 0,
          report: successfulBackfillChildReport(input.reportPath, {
            final_status: "protected_r2_phase_completed",
          }),
          report_read_error: null,
        };
      },
    });
    assert.equal(result.report.ok, true);
    assert.equal(result.report.per_year_results[0].unchanged_no_op_scope_count, 1);
    assert.equal(result.report.per_year_results[0].r2_changed_scope_count, 0);
  }
  assert.deepEqual(attempted, [
    { runId: "backfill-first-run", year: 2020 },
    { runId: "backfill-second-run", year: 2020 },
  ]);
});

test("the Black Carbon workflow generates artifact-safe run directory names", async () => {
  const workflow = await fs.readFile(new URL(
    "../.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml",
    import.meta.url,
  ), "utf8");
  assert.ok(workflow.includes(
    "--run-id \"ukair-bc-gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}\"",
  ));
  assert.ok(!workflow.includes("ukair-bc-gha:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}"));
});
