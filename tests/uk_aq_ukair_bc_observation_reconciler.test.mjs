import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUkAirBlackCarbonAnnualUrl,
  parseUkAirBlackCarbonAnnualCsv,
  requiredBlackCarbonAnnualSourceYears,
  routeBlackCarbonSelectedScopes,
} from "../scripts/ukair_bc/uk_air_black_carbon_source.mjs";
import {
  parseReconcilerArgs,
  planAnnualSourceRequests,
  resolveBlackCarbonMetadata,
  runLockedReconciliation,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler.mjs";
import {
  mergeSelectedTimeseriesRows,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler_locked.mjs";
import {
  OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES,
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

function annualCsv(series = "Black Carbon (880nm)") {
  return Buffer.from([
    "Data supplied by UK-AIR on 02 July 2026",
    "All Data GMT hour ending",
    "Rows begining ## are Provisional",
    `Date,Time,"${series}",Status,Unit`,
    "30-06-2026,24:00,0,P,ugm-3",
    "##01-07-2026,01:00,1.25,,ugm-3",
    "01-07-2026,02:00,,,",
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
  assert.equal(parsed.source_rows, 3);
  assert.equal(parsed.valid_observation_count, 2);
  assert.equal(parsed.missing_cell_count, 1);
  assert.equal(parsed.provisional_count, 1);
  assert.equal(parsed.ratified_count, 1);
  assert.equal(parsed.zero_count, 1);
  assert.deepEqual(parsed.per_partition_day_row_counts, { "2026-07-01": 2 });
});

test("Black Carbon annual parser fails closed for a contradictory source series", () => {
  assert.throws(
    () => parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv("UV Particulate Matter (370nm)"),
      sourceProperty: "bc",
      sourceYear: 2026,
      ukAirRef: "UKA01055",
      siteRef: "SHUN",
    }),
    /source-property header mismatch for bc/,
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
