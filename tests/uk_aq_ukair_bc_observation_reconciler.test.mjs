import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  buildDesiredScopes,
  parseReconcilerArgs,
  planAnnualSourceRequests,
  resolveBlackCarbonMetadata,
  runBlackCarbonObservationReconciler,
  runLockedReconciliation,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler.mjs";
import {
  currentConnectorManifest,
  filterChangedWriterInputs,
  mergeSelectedTimeseriesRows,
  readCurrentPollutantState,
  writerBatches,
} from "../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler_locked.mjs";
import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  buildObservationHistoryExactLeafIndexV3Latest,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
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
const ALL_UTC_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => hour));

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

function publishedCanonicalAndExactFixtureObjects(fixture) {
  const objects = canonicalFixtureObjects(fixture);
  for (const artifact of fixture.partition.v3_hierarchy.publication_objects) {
    objects.set(artifact.key, Buffer.from(artifact.body));
  }
  const latest = buildObservationHistoryExactLeafIndexV3Latest({
    scopedHierarchies: [fixture.partition.v3_hierarchy],
    indexRoot: fixture.generation.observations_timeseries_index_prefix,
    latestKey: fixture.generation.observations_timeseries_latest_key,
  });
  objects.set(latest.key, Buffer.from(latest.body));
  return objects;
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

function selectedScopePlan(rows) {
  return {
    target_writer_git_sha: TEST_WRITER_GIT_SHA,
    partitions: [{
      scope: TEST_SCOPE,
      rows,
      selected_timeseries_authority: [{
        timeseries_id: 201,
        authoritative_hours_utc: ALL_UTC_HOURS,
      }],
    }],
    removed_scopes: [],
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

function blackCarbonStation({
  stationId,
  timeseriesId,
  ukAirRef,
  siteRef,
  supportingFiles,
}) {
  return {
    station_id: stationId,
    uk_air_ref: ukAirRef,
    site_ref: siteRef,
    raw_payload: supportingFiles === undefined ? {} : {
      supported_properties: ["bc"],
      supporting_files: { bc: supportingFiles },
    },
    timeseries: new Map([["bc", {
      timeseries_id: timeseriesId,
      timeseries_ref: `${ukAirRef}:bc`,
      pollutant_code: "bc",
    }]]),
  };
}

function acquiredBlackCarbonSource(station, rows, sourceYear = 2026) {
  return {
    identity: `${station.uk_air_ref}\u0000bc\u0000${sourceYear}`,
    status: "pinned",
    parse_status: "parsed",
    parsed: parseUkAirBlackCarbonAnnualCsv({
      bytes: annualCsv({ rows }),
      sourceProperty: "bc",
      sourceYear,
      ukAirRef: station.uk_air_ref,
      siteRef: station.site_ref,
    }),
  };
}

function buildCurrentYearDesiredScopes({
  days,
  stations,
  acquiredSources,
  acquisitionPlan = { expectedAbsences: [], metadataBlockers: [] },
  requiredYearsByDay = new Map(days.map((day) => [day, [2026]])),
}) {
  return buildDesiredScopes({
    days,
    properties: ["bc"],
    metadata: {
      connector_id: 8,
      selected_stations: stations,
    },
    requiredYearsByDay,
    acquisitionPlan,
    acquiredSources,
    currentYear: 2026,
  });
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
  assert.equal(parsed.source_date_count, 2);
  assert.equal(parsed.first_source_date, "2026-06-30");
  assert.equal(parsed.last_source_date, "2026-07-01");
  assert.deepEqual(parsed.source_date_days, ["2026-06-30", "2026-07-01"]);
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
    selected_timeseries_authority: [{
      timeseries_id: 201,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
    conclusive: true,
  }, {
    day_utc: "2026-07-01",
    connector_id: 8,
    pollutant_code: "uv370",
    rows: [],
    selected_timeseries_authority: [{
      timeseries_id: 202,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
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
    selected_timeseries_authority: [{
      timeseries_id: 201,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
  }]);
  assert.deepEqual(routed.removedScopes, [
    {
      scope: { day_utc: "2026-07-01", connector_id: 8, pollutant_code: "uv370" },
      selected_timeseries_authority: [{
        timeseries_id: 202,
        authoritative_hours_utc: ALL_UTC_HOURS,
      }],
    },
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
    selectedTimeseriesAuthority: [{
      timeseries_id: 201,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
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
    selectedTimeseriesAuthority: [{
      timeseries_id: stationA.timeseries_id,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
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
    selectedTimeseriesAuthority: [{
      timeseries_id: stationA.timeseries_id,
      authoritative_hours_utc: ALL_UTC_HOURS,
    }],
  }), [{ ...stationA, value: 3 }, stationB]);
});

test("current-year missing station date skips only that timeseries and preserves canonical rows", () => {
  const missing = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "MISS",
  });
  const peer = blackCarbonStation({
    stationId: 102,
    timeseriesId: 202,
    ukAirRef: "UKA00002",
    siteRef: "PEER",
  });
  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations: [missing, peer],
    acquiredSources: [
      acquiredBlackCarbonSource(missing, [
        hourlyDataRow("01-09-2026", { 24: 1 }),
      ]),
      acquiredBlackCarbonSource(peer, [
        hourlyDataRow("01-09-2026", { 24: 2 }),
        hourlyDataRow("02-09-2026", { 1: 3 }),
      ]),
    ],
  });

  assert.equal(routed.blockedScopes.length, 0);
  assert.equal(routed.partitions.length, 1);
  assert.deepEqual(routed.partitions[0].selected_timeseries_authority, [{
    timeseries_id: 202,
    authoritative_hours_utc: ALL_UTC_HOURS,
  }]);
  assert.deepEqual(routed.partitions[0].rows.map((row) => row.timeseries_id), [202, 202]);
  assert.deepEqual(routed.temporarySourceGaps, [{
    station: "UKA00001",
    station_id: 101,
    timeseries_id: 201,
    timeseries_ref: "UKA00001:bc",
    property: "bc",
    canonical_day_utc: "2026-09-02",
    source_year: 2026,
    missing_source_date: "2026-09-02",
    reason: "temporary_current_year_source_date_not_present",
  }]);

  const existingMissingRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-09-02T01:00:00.000Z",
    value: 99,
    verification_status: "R",
  };
  const merged = mergeSelectedTimeseriesRows({
    currentRows: [existingMissingRow],
    desiredRows: routed.partitions[0].rows,
    selectedTimeseriesAuthority: routed.partitions[0].selected_timeseries_authority,
  });
  assert.ok(merged.some((row) => JSON.stringify(row) === JSON.stringify(existingMissingRow)));

  const later = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations: [missing, peer],
    acquiredSources: [
      acquiredBlackCarbonSource(missing, [
        hourlyDataRow("01-09-2026", { 24: 1 }),
        hourlyDataRow("02-09-2026", { 1: 7 }),
      ]),
      acquiredBlackCarbonSource(peer, [
        hourlyDataRow("01-09-2026", { 24: 2 }),
        hourlyDataRow("02-09-2026", { 1: 3 }),
      ]),
    ],
  });
  assert.deepEqual(
    later.partitions[0].selected_timeseries_authority.map((entry) => entry.timeseries_id),
    [201, 202],
  );
  assert.ok(later.partitions[0].rows.some(
    (row) => row.timeseries_id === 201 && row.value === 7,
  ));
});

test("current-year expected-file absence skips only that timeseries and later availability restores authority", () => {
  const missing = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "MISS",
    supportingFiles: [],
  });
  const peer = blackCarbonStation({
    stationId: 102,
    timeseriesId: 202,
    ukAirRef: "UKA00002",
    siteRef: "PEER",
    supportingFiles: ["PEER_BC_2026.csv"],
  });
  const acquisitionPlan = planAnnualSourceRequests({
    metadata: { selected_stations: [missing, peer] },
    properties: ["bc"],
    requiredYears: [2026],
  });
  assert.equal(acquisitionPlan.expectedAbsences.length, 1);
  assert.equal(acquisitionPlan.expectedAbsences[0].timeseries_id, 201);
  assert.equal(acquisitionPlan.expectedAbsences[0].authority,
    "ukair_bc_station_refs.raw_payload.supporting_files");

  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations: [missing, peer],
    acquisitionPlan,
    acquiredSources: [acquiredBlackCarbonSource(peer, [
      hourlyDataRow("01-09-2026", { 24: 2 }),
      hourlyDataRow("02-09-2026", { 1: 3 }),
    ])],
  });

  assert.equal(routed.blockedScopes.length, 0);
  assert.equal(routed.partitions.length, 1);
  assert.deepEqual(routed.partitions[0].selected_timeseries_authority, [{
    timeseries_id: 202,
    authoritative_hours_utc: ALL_UTC_HOURS,
  }]);
  assert.deepEqual(routed.temporarySourceGaps, [{
    station: "UKA00001",
    station_id: 101,
    timeseries_id: 201,
    timeseries_ref: "UKA00001:bc",
    property: "bc",
    canonical_day_utc: "2026-09-02",
    source_year: 2026,
    source_identity: "UKA00001\u0000bc\u00002026",
    expected_annual_filename: "MISS_BC_2026.csv",
    reason: "temporary_current_year_source_file_not_listed",
  }]);
  const existingMissingRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-09-02T01:00:00.000Z",
    value: 99,
    verification_status: "R",
  };
  const merged = mergeSelectedTimeseriesRows({
    currentRows: [existingMissingRow],
    desiredRows: routed.partitions[0].rows,
    selectedTimeseriesAuthority: routed.partitions[0].selected_timeseries_authority,
  });
  assert.ok(merged.some((row) => JSON.stringify(row) === JSON.stringify(existingMissingRow)));

  const nowAvailable = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "MISS",
    supportingFiles: ["MISS_BC_2026.csv"],
  });
  const laterPlan = planAnnualSourceRequests({
    metadata: { selected_stations: [nowAvailable, peer] },
    properties: ["bc"],
    requiredYears: [2026],
  });
  const later = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations: [nowAvailable, peer],
    acquisitionPlan: laterPlan,
    acquiredSources: [
      acquiredBlackCarbonSource(nowAvailable, [
        hourlyDataRow("01-09-2026", { 24: 1 }),
        hourlyDataRow("02-09-2026", { 1: 7 }),
      ]),
      acquiredBlackCarbonSource(peer, [
        hourlyDataRow("01-09-2026", { 24: 2 }),
        hourlyDataRow("02-09-2026", { 1: 3 }),
      ]),
    ],
  });
  assert.equal(later.temporarySourceGaps.length, 0);
  assert.deepEqual(
    later.partitions[0].selected_timeseries_authority.map((entry) => entry.timeseries_id),
    [201, 202],
  );
});

test("all current-year expected-file absences route to the successful uncovered no-op path", () => {
  const stations = [
    blackCarbonStation({
      stationId: 101,
      timeseriesId: 201,
      ukAirRef: "UKA00001",
      siteRef: "ONE",
      supportingFiles: [],
    }),
    blackCarbonStation({
      stationId: 102,
      timeseriesId: 202,
      ukAirRef: "UKA00002",
      siteRef: "TWO",
      supportingFiles: [],
    }),
  ];
  const acquisitionPlan = planAnnualSourceRequests({
    metadata: { selected_stations: stations },
    properties: ["bc"],
    requiredYears: [2026],
  });
  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations,
    acquisitionPlan,
    acquiredSources: [],
  });

  assert.equal(routed.blockedScopes.length, 0);
  assert.equal(routed.partitions.length, 0);
  assert.equal(routed.removedScopes.length, 0);
  assert.equal(routed.temporarySourceGaps.length, 2);
  assert.deepEqual(routed.skippedUncoveredScopes, [{
    day_utc: "2026-09-02",
    connector_id: 8,
    pollutant_code: "bc",
    reason: "all_selected_timeseries_temporarily_uncovered",
    temporarily_uncovered_timeseries_count: 2,
  }]);
});

test("current-year expected-file absence wins over previous-year 24:00 at 1 January", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "BOUND",
    supportingFiles: ["BOUND_BC_2025.csv"],
  });
  const acquisitionPlan = planAnnualSourceRequests({
    metadata: { selected_stations: [station] },
    properties: ["bc"],
    requiredYears: [2025, 2026],
  });
  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-01-01"],
    stations: [station],
    acquisitionPlan,
    acquiredSources: [acquiredBlackCarbonSource(station, [
      hourlyDataRow("31-12-2025", { 24: 7 }),
    ], 2025)],
    requiredYearsByDay: new Map([["2026-01-01", [2025, 2026]]]),
  });

  assert.equal(routed.blockedScopes.length, 0);
  assert.equal(routed.partitions.length, 0);
  assert.equal(routed.removedScopes.length, 0);
  assert.equal(routed.skippedUncoveredScopes.length, 1);
  assert.equal(routed.temporarySourceGaps[0].reason,
    "temporary_current_year_source_file_not_listed");
});

test("represented current-year blank source dates retain selected removal authority", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "BLNK",
  });
  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-09-02"],
    stations: [station],
    acquiredSources: [acquiredBlackCarbonSource(station, [
      hourlyDataRow("01-09-2026", {}),
      hourlyDataRow("02-09-2026", {}),
    ])],
  });

  assert.equal(routed.temporarySourceGaps.length, 0);
  assert.equal(routed.removedScopes.length, 1);
  const removal = routed.removedScopes[0];
  assert.deepEqual(removal.selected_timeseries_authority, [{
    timeseries_id: 201,
    authoritative_hours_utc: ALL_UTC_HOURS,
  }]);
  assert.deepEqual(mergeSelectedTimeseriesRows({
    currentRows: [{
      connector_id: 8,
      station_id: 101,
      timeseries_id: 201,
      pollutant_code: "bc",
      observed_at_utc: "2026-09-02T01:00:00.000Z",
      value: 4,
      verification_status: "R",
    }],
    desiredRows: [],
    selectedTimeseriesAuthority: removal.selected_timeseries_authority,
  }), []);
});

test("represented blank authority materializes through the protected explicit-removal path", async () => {
  const currentRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 4,
    verification_status: "R",
  };
  const fixture = blackCarbonCanonicalFixture([currentRow]);
  const { r2 } = memoryR2(publishedCanonicalAndExactFixtureObjects(fixture));
  const filtered = await filterChangedWriterInputs({
    plan: {
      target_writer_git_sha: TEST_WRITER_GIT_SHA,
      partitions: [],
      removed_scopes: [{
        scope: TEST_SCOPE,
        selected_timeseries_authority: [{
          timeseries_id: 201,
          authoritative_hours_utc: ALL_UTC_HOURS,
        }],
      }],
    },
    r2,
    generation: fixture.generation,
  });

  assert.deepEqual(filtered.partitions, []);
  assert.deepEqual(filtered.removedScopes, [TEST_SCOPE]);
  assert.deepEqual(filtered.unchangedScopes, []);
});

test("internal current-year source gaps are skipped while resumed dates reconcile covered hours", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "GAPS",
  });
  const acquired = acquiredBlackCarbonSource(station, [
    hourlyDataRow("01-09-2026", { 1: 1 }),
    hourlyDataRow("10-09-2026", { 1: 10 }),
  ]);
  const routed = buildCurrentYearDesiredScopes({
    days: ["2026-09-05", "2026-09-10"],
    stations: [station],
    acquiredSources: [acquired],
  });

  assert.deepEqual(routed.skippedUncoveredScopes, [{
    day_utc: "2026-09-05",
    connector_id: 8,
    pollutant_code: "bc",
    reason: "all_selected_timeseries_temporarily_uncovered",
    temporarily_uncovered_timeseries_count: 1,
  }]);
  assert.equal(routed.partitions.length, 1);
  assert.equal(routed.partitions[0].scope.day_utc, "2026-09-10");
  assert.deepEqual(
    routed.partitions[0].selected_timeseries_authority[0].authoritative_hours_utc,
    ALL_UTC_HOURS.slice(1),
  );
  const preservedMidnight = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-09-10T00:00:00.000Z",
    value: 9,
    verification_status: "R",
  };
  const merged = mergeSelectedTimeseriesRows({
    currentRows: [preservedMidnight, { ...preservedMidnight,
      observed_at_utc: "2026-09-10T01:00:00.000Z", value: 2 }],
    desiredRows: routed.partitions[0].rows,
    selectedTimeseriesAuthority: routed.partitions[0].selected_timeseries_authority,
  });
  assert.ok(merged.some((row) => JSON.stringify(row) === JSON.stringify(preservedMidnight)));
  assert.ok(merged.some((row) => row.observed_at_utc.endsWith("T01:00:00.000Z") && row.value === 10));
});

test("current-year acquisition and parse failures still block the canonical scope", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "FAIL",
  });
  for (const [source, expected] of [[{
    identity: "UKA00001\u0000bc\u00002026",
    status: "failed",
    error: "UK-AIR HTTP 503",
  }, /UK-AIR HTTP 503/], [{
    identity: "UKA00001\u0000bc\u00002026",
    status: "pinned",
    parse_status: "failed",
    parse_error: "source series mismatch",
  }, /source series mismatch/]]) {
    const routed = buildCurrentYearDesiredScopes({
      days: ["2026-09-02"],
      stations: [station],
      acquiredSources: [source],
    });

    assert.equal(routed.partitions.length, 0);
    assert.equal(routed.removedScopes.length, 0);
    assert.equal(routed.skippedUncoveredScopes.length, 0);
    assert.equal(routed.blockedScopes.length, 1);
    assert.match(routed.blockedScopes[0].blocked_reason, expected);
  }
});

test("historical parsed files retain the existing conclusive selected-scope semantics", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "HIST",
  });
  const parsed = parseUkAirBlackCarbonAnnualCsv({
    bytes: annualCsv({ rows: [hourlyDataRow("01-01-2025", { 1: 1 })] }),
    sourceProperty: "bc",
    sourceYear: 2025,
    ukAirRef: station.uk_air_ref,
    siteRef: station.site_ref,
  });
  const routed = buildDesiredScopes({
    days: ["2025-09-02"],
    properties: ["bc"],
    metadata: { connector_id: 8, selected_stations: [station] },
    requiredYearsByDay: new Map([["2025-09-02", [2025]]]),
    acquisitionPlan: { expectedAbsences: [], metadataBlockers: [] },
    acquiredSources: [{
      identity: "UKA00001\u0000bc\u00002025",
      status: "pinned",
      parse_status: "parsed",
      parsed,
    }],
    currentYear: 2026,
  });

  assert.equal(routed.temporarySourceGaps.length, 0);
  assert.equal(routed.skippedUncoveredScopes.length, 0);
  assert.equal(routed.removedScopes.length, 1);
  assert.deepEqual(routed.removedScopes[0].selected_timeseries_authority, [{
    timeseries_id: 201,
    authoritative_hours_utc: ALL_UTC_HOURS,
  }]);
});

test("historical expected-file absence retains conclusive selected-scope semantics", () => {
  const station = blackCarbonStation({
    stationId: 101,
    timeseriesId: 201,
    ukAirRef: "UKA00001",
    siteRef: "HIST",
    supportingFiles: [],
  });
  const acquisitionPlan = planAnnualSourceRequests({
    metadata: { selected_stations: [station] },
    properties: ["bc"],
    requiredYears: [2025],
  });
  const routed = buildDesiredScopes({
    days: ["2025-09-02"],
    properties: ["bc"],
    metadata: { connector_id: 8, selected_stations: [station] },
    requiredYearsByDay: new Map([["2025-09-02", [2025]]]),
    acquisitionPlan,
    acquiredSources: [],
    currentYear: 2026,
  });

  assert.equal(routed.temporarySourceGaps.length, 0);
  assert.equal(routed.skippedUncoveredScopes.length, 0);
  assert.equal(routed.removedScopes.length, 1);
  assert.deepEqual(routed.removedScopes[0].selected_timeseries_authority, [{
    timeseries_id: 201,
    authoritative_hours_utc: ALL_UTC_HOURS,
  }]);
});

test("an identical selected-scope lifecycle is a no-op when canonical and exact-v3 bodies match", async () => {
  const selectedRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  };
  const peerRow = {
    ...selectedRow,
    station_id: 102,
    timeseries_id: 202,
    value: 2,
  };
  const fixture = blackCarbonCanonicalFixture([selectedRow, peerRow]);
  const { r2 } = memoryR2(publishedCanonicalAndExactFixtureObjects(fixture));

  const filtered = await filterChangedWriterInputs({
    plan: selectedScopePlan([selectedRow]),
    r2,
    generation: fixture.generation,
  });

  assert.deepEqual(filtered.partitions, []);
  assert.deepEqual(filtered.removedScopes, []);
  assert.deepEqual(filtered.unchangedScopes, [{ ...TEST_SCOPE, status: "unchanged" }]);
  assert.deepEqual(filtered.scopeComparisonDiagnostics, [{
    ...TEST_SCOPE,
    category: "unchanged",
    comparison_stage: "complete",
  }]);
  assert.deepEqual(writerBatches(filtered), []);
});

test("changed selected canonical rows remain eligible for reconciliation", async () => {
  const currentRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  };
  const fixture = blackCarbonCanonicalFixture([currentRow]);
  const { r2 } = memoryR2(publishedCanonicalAndExactFixtureObjects(fixture));

  const filtered = await filterChangedWriterInputs({
    plan: selectedScopePlan([{ ...currentRow, value: 3 }]),
    r2,
    generation: fixture.generation,
  });

  assert.equal(filtered.partitions.length, 1);
  assert.deepEqual(filtered.unchangedScopes, []);
  assert.equal(filtered.scopeComparisonDiagnostics[0].category, "canonical_physical_mismatch");
  assert.equal(filtered.scopeComparisonDiagnostics[0].comparison_stage, "canonical_physical");
  assert.ok(writerBatches(filtered).length > 0);
});

test("correct canonical rows with a corrupt exact-v3 publication object remain eligible for reconciliation", async () => {
  const currentRow = {
    connector_id: 8,
    station_id: 101,
    timeseries_id: 201,
    pollutant_code: "bc",
    observed_at_utc: "2026-07-01T01:00:00.000Z",
    value: 1,
    verification_status: "R",
  };
  const fixture = blackCarbonCanonicalFixture([currentRow]);
  const objects = publishedCanonicalAndExactFixtureObjects(fixture);
  const corruptLeaf = fixture.partition.v3_hierarchy.publication_objects.find(
    (artifact) => artifact.kind === "observation_history_index_v3_exact_leaf",
  );
  assert.ok(corruptLeaf);
  const corruptBody = Buffer.from(objects.get(corruptLeaf.key));
  corruptBody[0] = corruptBody[0] === 0x7b ? 0x5b : 0x7b;
  objects.set(corruptLeaf.key, corruptBody);
  const { r2 } = memoryR2(objects);

  const filtered = await filterChangedWriterInputs({
    plan: selectedScopePlan([currentRow]),
    r2,
    generation: fixture.generation,
  });

  assert.equal(filtered.partitions.length, 1);
  assert.deepEqual(filtered.unchangedScopes, []);
  assert.deepEqual(filtered.scopeComparisonDiagnostics, [{
    ...TEST_SCOPE,
    category: "exact_publication_object_mismatch",
    comparison_stage: "exact_publication_object",
    key: corruptLeaf.key,
    expected: {
      key: corruptLeaf.key,
      byte_size: corruptLeaf.byte_size,
      sha256: corruptLeaf.sha256,
    },
    actual: {
      key: corruptLeaf.key,
      byte_size: corruptBody.byteLength,
      sha256: createHash("sha256").update(corruptBody).digest("hex"),
    },
  }]);
  assert.ok(writerBatches(filtered).length > 0);
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
