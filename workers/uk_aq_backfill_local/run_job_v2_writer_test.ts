import {
  buildDedicatedSosSourceAcquisition,
  classifyObservationRowsForV2PollutantPartitions,
  createAqiV2ConnectorManifest,
  createAqiV2PollutantManifest,
  loadSosSiteRefBridgeSnapshot,
  normaliseConcentrationUnitForComparison,
  parseOpenaqCsvObservations,
  parseUkAirFlatFileObservations,
  summarizeAqilevelsPartRows,
  validateIntegrityCoreSnapshotIdentityPayload,
} from "./run_job.ts";

const propertyMapping = (sourceLabel: string, code: string, sourceUom = "ug/m3") => ({
  connector_id: 1,
  source_label: sourceLabel,
  source_uom: sourceUom,
  observed_property_id: 1,
  observed_property_code: code,
  mapping_kind: "raw_observed_property" as const,
  is_aqi_eligible: ["pm25", "pm10", "no2"].includes(code),
  is_active: true,
});
function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`assertEquals failed: actual=${actualJson} expected=${expectedJson}`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function testSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("Integrity worker keeps the coordinator core snapshot pin after UTC midnight", async () => {
  const selectedAtUtc = "2026-08-03T23:59:00.000Z";
  const childStartedAtUtc = "2026-08-04T00:01:00.000Z";
  const manifestHash = "a".repeat(64);
  const manifestBody = new TextEncoder().encode(JSON.stringify({
    day_utc: "2026-08-03",
    manifest_hash: manifestHash,
    tables: [],
  }));
  const identity = {
    core_snapshot_day_utc: "2026-08-03",
    core_snapshot_manifest_key:
      "history/v2/core/day_utc=2026-08-03/manifest.json",
    core_snapshot_manifest_hash: manifestHash,
    core_snapshot_manifest_sha256: await testSha256(
      new TextDecoder().decode(manifestBody),
    ),
  };

  const requested = validateIntegrityCoreSnapshotIdentityPayload({
    coordinatorIdentity: identity,
    recordedIdentity: identity,
    manifestBody,
    stage: `worker_after_midnight:${selectedAtUtc}:${childStartedAtUtc}`,
  });

  assertEquals(requested.core_snapshot_day_utc, "2026-08-03");
  assertEquals(
    requested.core_snapshot_manifest_key,
    "history/v2/core/day_utc=2026-08-03/manifest.json",
  );
});

Deno.test("v2 SOS bridge snapshot preserves imported mapping identity", async () => {
  const tempDir = await Deno.makeTempDir();
  const path = `${tempDir}/sos-site-ref-bridge.json`;
  const semantic = {
    schema_version: 1,
    connector_id: 1,
    mapping_identity: "sos_station_timeseries_site_refs_snapshot",
    bridge_artifact_sha256: "a".repeat(64),
    bridge_artifact_row_count: 2,
    selected_bridge_row_count: 1,
    bridge_row_count: 2,
    rows: [{
      site_ref: "abd9",
      uk_air_ref: null,
      pollutant_code: "no2",
      station_id: 81,
      timeseries_id: 144,
      station_ref: "8126",
      timeseries_ref: "ts-144",
      valid_from_day_utc: "2026-01-01",
      valid_to_day_utc: null,
    }],
  };
  const payload = {
    ...semantic,
    bridge_content_sha256: await testSha256(canonicalJson(semantic)),
  };
  await Deno.writeTextFile(path, JSON.stringify(payload));
  Deno.env.set("UK_AQ_BACKFILL_SOS_SITE_REF_BRIDGE_FILE", path);
  try {
    const loaded = loadSosSiteRefBridgeSnapshot();
    assertEquals(loaded?.mapping_identity, semantic.mapping_identity);
    assertEquals(loaded?.mapping_hash, semantic.bridge_artifact_sha256);
    assertEquals(loaded?.bridge_artifact_row_count, 2);
    assertEquals(loaded?.selected_bridge_row_count, 1);
    assertEquals(loaded?.rows[0].site_ref, "ABD9");
    assertEquals(loaded?.rows[0].timeseries_id, 144);
  } finally {
    Deno.env.delete("UK_AQ_BACKFILL_SOS_SITE_REF_BRIDGE_FILE");
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("UK-AIR concentration-unit aliases preserve scale and reject a different scale", () => {
  assertEquals(
    ["ug/m3", "ugm-3", "ug m-3", "µg/m3", "μg/m3", "µg/m³", "μg/m³"]
      .map(normaliseConcentrationUnitForComparison),
    ["ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3", "ug/m3"],
  );
  assertEquals(
    ["mg/m3", "mgm-3", "mg m-3", "mg/m³"]
      .map(normaliseConcentrationUnitForComparison),
    ["mg/m3", "mg/m3", "mg/m3", "mg/m3"],
  );
  assertEquals(
    normaliseConcentrationUnitForComparison("mg/m3") ===
      normaliseConcentrationUnitForComparison("ug/m3"),
    false,
  );
});

Deno.test("dedicated SOS acquisition crosses a month once for a 3-day x 2-pollutant scope", async () => {
  const tempDir = await Deno.makeTempDir();
  const acquisitionRoot = `${tempDir}/sos-source-cache`;
  const no2Label = "Nitrogen dioxide (Hourly measured)";
  const pm25Label = "PM2.5 particulate matter (Hourly measured)";
  const csvText = [
    "All Data GMT hour ending",
    `Date,time,"${no2Label}",status,unit,"${pm25Label}",status,unit`,
    "30-06-2026,01:00,10,P,ugm-3,20,R,ugm-3",
    "01-07-2026,01:00,,,,21,P,ugm-3",
    "02-07-2026,01:00,12,P,ugm-3,,,,",
  ].join("\n");
  const sourceReads = new Map<string, number>();
  const registryEntries = new Map([
    [no2Label.toLowerCase(), {
      normalised_source_label: no2Label.toLowerCase(),
      status: "mapped" as const,
      pollutant_code: "no2",
      expected_uom: "ug/m3",
      raw_label_variants: [no2Label],
      observed_units: ["ugm-3"],
      reviewed_at_utc: "2026-07-31T00:00:00Z",
      review_notes: null,
    }],
    [pm25Label.toLowerCase(), {
      normalised_source_label: pm25Label.toLowerCase(),
      status: "mapped" as const,
      pollutant_code: "pm25",
      expected_uom: "ug/m3",
      raw_label_variants: [pm25Label],
      observed_units: ["ugm-3"],
      reviewed_at_utc: "2026-07-31T00:00:00Z",
      review_notes: null,
    }],
  ]);
  const bridgeRows = [
    {
      site_ref: "ABC",
      uk_air_ref: "ABC",
      pollutant_code: "no2" as const,
      station_id: 10,
      timeseries_id: 101,
      station_ref: "station-abc",
      timeseries_ref: "timeseries-abc-no2",
      valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: null,
    },
    {
      site_ref: "ABC",
      uk_air_ref: "ABC",
      pollutant_code: "pm25" as const,
      station_id: 10,
      timeseries_id: 102,
      station_ref: "station-abc",
      timeseries_ref: "timeseries-abc-pm25",
      valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: "2026-06-30",
    },
  ];
  try {
    const manifest = await buildDedicatedSosSourceAcquisition({
      root: acquisitionRoot,
      runId: "focused-run",
      requestedDays: ["2026-06-30", "2026-07-01", "2026-07-02"],
      requestedPollutants: ["no2", "pm25"],
      sourceRoot: "/virtual-sos",
      sourceReader: (sourcePath) => {
        sourceReads.set(sourcePath, (sourceReads.get(sourcePath) || 0) + 1);
        return csvText;
      },
      sourceStat: () => ({
        size: new TextEncoder().encode(csvText).length,
        mtimeMs: 1_786_000_000_000,
      }),
      bridge: {
        connector_id: 1,
        mapping_identity: "sos_station_timeseries_site_refs_snapshot",
        mapping_hash: "a".repeat(64),
        content_hash: "b".repeat(64),
        bridge_artifact_row_count: 2,
        selected_bridge_row_count: 2,
        rows: bridgeRows,
      },
      propertyMappings: [
        propertyMapping(no2Label, "no2"),
        propertyMapping(pm25Label, "pm25"),
      ],
      registryEntries,
    });
    assertEquals(manifest.acquisition_status, "complete");
    assertEquals(manifest.selected_from_day, "2026-06-30");
    assertEquals(manifest.selected_to_day, "2026-07-02");
    assertEquals(manifest.selected_days, [
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
    assertEquals(manifest.requested_pollutants, ["no2", "pm25"]);
    assertEquals(manifest.partition_dataset_count, 6);
    assertEquals(manifest.unique_source_file_count, 1);
    assertEquals(manifest.source_files_opened, 1);
    assertEquals(manifest.maximum_source_file_open_count, 1);
    assertEquals(Array.from(sourceReads.values()), [1]);
    assertEquals(manifest.partition_row_counts, {
      "2026-06-30|no2": 1,
      "2026-06-30|pm25": 1,
      "2026-07-01|no2": 0,
      "2026-07-01|pm25": 0,
      "2026-07-02|no2": 1,
      "2026-07-02|pm25": 0,
    });
    const partitionFiles = manifest.partition_files as Array<
      Record<string, unknown>
    >;
    assertEquals(new Set(partitionFiles.map((entry) => entry.path)).size, 6);
    assertEquals(new Set(partitionFiles.map((entry) => entry.sha256)).size, 6);
    const emptyPartition = partitionFiles.find((entry) =>
      entry.day_utc === "2026-07-01" && entry.pollutant_code === "no2"
    );
    assertEquals(emptyPartition?.row_count, 0);
    const unmappedPartition = partitionFiles.find((entry) =>
      entry.day_utc === "2026-07-01" && entry.pollutant_code === "pm25"
    );
    const unmappedPayload = JSON.parse(
      await Deno.readTextFile(String(unmappedPartition?.path)),
    );
    assertEquals(unmappedPayload.source_file_results[0].parsed.rows, []);
    assertEquals(
      unmappedPayload.source_file_results[0].parsed.missing_binding_rows,
      1,
    );
    assertEquals(manifest.detector_rescans_avoided, 6);
    assertEquals(manifest.proposal_builder_rescans_avoided, 6);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(acquisitionRoot)))
        .filter((entry) => entry.name === "acquisition-manifest.json").length,
      1,
    );
    let secondAcquisitionError = "";
    try {
      await buildDedicatedSosSourceAcquisition({
        root: acquisitionRoot,
        runId: "focused-run",
        requestedDays: ["2026-06-30", "2026-07-01", "2026-07-02"],
        requestedPollutants: ["no2", "pm25"],
        sourceRoot: "/virtual-sos",
        sourceReader: () => csvText,
        sourceStat: () => ({ size: csvText.length, mtimeMs: 1 }),
        bridge: {
          connector_id: 1,
          mapping_identity: "sos_station_timeseries_site_refs_snapshot",
          mapping_hash: "a".repeat(64),
          content_hash: "b".repeat(64),
          bridge_artifact_row_count: 2,
          selected_bridge_row_count: 2,
          rows: bridgeRows,
        },
        propertyMappings: [
          propertyMapping(no2Label, "no2"),
          propertyMapping(pm25Label, "pm25"),
        ],
        registryEntries,
      });
    } catch (error) {
      secondAcquisitionError = String(error);
    }
    if (
      !secondAcquisitionError.includes(
        "sos_source_acquisition_root_already_exists",
      )
    ) {
      throw new Error(
        `expected existing-root guard, got: ${secondAcquisitionError}`,
      );
    }
    assertEquals(Array.from(sourceReads.values()), [1]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("v2 classifier skips blank, null, and invalid pollutant_code rows", () => {
  const classified = classifyObservationRowsForV2PollutantPartitions([
    { timeseries_id: 1, station_id: 10, pollutant_code: "pm25", observed_at: "2026-06-08T00:00:00.000Z", value: 1 },
    { timeseries_id: 2, station_id: 20, pollutant_code: "", observed_at: "2026-06-08T01:00:00.000Z", value: 2, source_parameter: "pm10" },
    { timeseries_id: 3, station_id: 30, pollutant_code: null, observed_at: "2026-06-08T02:00:00.000Z", value: 3 },
    { timeseries_id: 4, station_id: 40, pollutant_code: "pm 10", observed_at: "2026-06-08T03:00:00.000Z", value: 4 },
    { timeseries_id: 5, station_id: 50, pollutant_code: "NO2", observed_at: "2026-06-08T04:00:00.000Z", value: 5 },
  ] as never);

  assertEquals(classified.valid_rows.map((row) => row.pollutant_code), ["pm25", "no2"]);
  assertEquals(classified.pollutant_codes_written, ["no2", "pm25"]);
  assertEquals(classified.rows_with_missing_pollutant_code, 3);
  assertEquals(classified.rows_skipped_missing_pollutant_code, 3);
  assertEquals(classified.example_missing_pollutant_rows.length, 3);
  assertEquals(classified.example_missing_pollutant_rows[0], {
    timeseries_id: 2,
    station_id: 20,
    observed_at: "2026-06-08T01:00:00.000Z",
    source_parameter: "pm10",
  });
});

Deno.test("OpenAQ CSV mapping populates pollutant_code from source parameter when binding code is blank at runtime", () => {
  const lookup = {
    connector_id: 6,
    station_refs: new Set(["42"]),
    binding_by_station_pollutant: new Map([["42|pm25", {
      timeseries_id: 1001,
      station_id: 42,
      station_ref: "42",
      timeseries_ref: "sensor-1",
      pollutant_code: "" as never,
    }]]),
    binding_by_timeseries_id: new Map(),
    binding_by_timeseries_ref: new Map(),
    binding_by_timeseries_ref_pollutant: new Map(),
    ambiguous_station_pollutant_keys: new Set<string>(),
    ambiguous_timeseries_ref_keys: new Set<string>(),
    ambiguous_timeseries_ref_pollutant_keys: new Set<string>(),
  };
  const csvText = [
    "location_id,sensors_id,datetime,parameter,value",
    "42,sensor-1,2026-06-08T00:00:00Z,pm25,12.5",
  ].join("\n");

  const parsed = parseOpenaqCsvObservations({
    dayUtc: "2026-06-08",
    csvText,
    lookup,
    locationId: 42,
    includeMetFields: false,
  });

  assertEquals(parsed.mapped_records, 1);
  assertEquals(parsed.rows[0].pollutant_code, "pm25");
  assertEquals(parsed.rows[0].source_parameter, "pm25");
});

Deno.test("UK-AIR CSV preserves ordinary UTC times and rolls 24:00 into the next partition", () => {
  const mappings = [{
    site_ref: "EA8",
    uk_air_ref: "EA8",
    pollutant_code: "pm10" as const,
    station_id: 1,
    timeseries_id: 66,
    station_ref: "station-ea8",
    timeseries_ref: "timeseries-old",
    valid_from_day_utc: "2020-01-01",
    valid_to_day_utc: "2026-05-17",
  }, {
    site_ref: "EA8",
    uk_air_ref: "EA8",
    pollutant_code: "pm10" as const,
    station_id: 1,
    timeseries_id: 95,
    station_ref: "station-ea8",
    timeseries_ref: "timeseries-new",
    valid_from_day_utc: "2026-05-18",
    valid_to_day_utc: null,
  }];
  const csvText = [
    "Station metadata",
    "All Data GMT hour ending ",
    'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
    "17-05-2026,01:00,10,R,ugm-3",
    "17-05-2026,24:00,11,P,ugm-3",
    "18-05-2026,01:00,12,R,ugm-3",
  ].join("\n");
  const propertyMappings = [
    propertyMapping("PM<sub>10</sub> particulate matter (Hourly measured)", "pm10"),
  ];
  const firstDay = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "EA8",
    csvText,
    mappings,
    propertyMappings,
  });
  const secondDay = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-18",
    siteRef: "EA8",
    csvText,
    mappings,
    propertyMappings,
  });

  assertEquals(firstDay.rows.map((row) => row.observed_at), [
    "2026-05-17T01:00:00.000Z",
  ]);
  assertEquals(firstDay.rows.map((row) => row.value), [10]);
  assertEquals(firstDay.rows.map((row) => row.status), ["R"]);
  assertEquals(firstDay.rows.map((row) => row.timeseries_id), [66]);
  assertEquals(secondDay.rows.map((row) => row.observed_at), [
    "2026-05-18T00:00:00.000Z",
    "2026-05-18T01:00:00.000Z",
  ]);
  assertEquals(secondDay.rows.map((row) => row.value), [11, 12]);
  assertEquals(secondDay.rows.map((row) => row.status), ["P", "R"]);
  assertEquals(secondDay.rows.map((row) => row.timeseries_id), [95, 95]);
  assertEquals(secondDay.units, ["ugm-3"]);
});

Deno.test("UK-AIR CSV time-basis declaration accepts notes and warns without blocking", () => {
  const sourceLabel = "PM<sub>10</sub> particulate matter (Hourly measured)";
  const baseArgs = {
    dayUtc: "2026-05-17",
    siteRef: "HORS",
    sourceFile: "HORS_2025.csv",
    mappings: [{
      site_ref: "HORS", uk_air_ref: "HORS", pollutant_code: "pm10" as const,
      station_id: 1, timeseries_id: 66, station_ref: "station-hors",
      timeseries_ref: "timeseries-hors", valid_from_day_utc: null,
      valid_to_day_utc: null,
    }],
    propertyMappings: [propertyMapping(sourceLabel, "pm10")],
  };
  const csv = (declaration: string) => [
    declaration,
    `Date,time,"${sourceLabel}",status,unit`,
    "17-05-2026,01:00,10,R,ugm-3",
  ].join("\n");

  assertEquals(
    parseUkAirFlatFileObservations({ ...baseArgs, csvText: csv("All Data GMT hour ending") }).rows.length,
    1,
  );
  assertEquals(
    parseUkAirFlatFileObservations({
      ...baseArgs,
      csvText: csv(
        "All Data GMT hour ending  NB: Upto 21/07/2025 PM10 were measured with a BAM 1020 heated",
      ),
    }).rows.length,
    1,
  );

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  try {
    assertEquals(
      parseUkAirFlatFileObservations({
        ...baseArgs,
        csvText: csv("Station metadata without the time-basis declaration"),
      }).rows.length,
      1,
    );
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length, 1);
  const warning = JSON.parse(warnings[0]);
  assertEquals(warning.event, "sos_uk_air_csv_time_basis_warning");
  assertEquals(warning.site_ref, "HORS");
  assertEquals(warning.source_file, "HORS_2025.csv");
  assertEquals(warning.expected_phrase, "All Data GMT hour ending");
});

Deno.test("UK-AIR CSV excludes blank and non-numeric values but retains finite negatives", () => {
  const sourceLabel = "Nitrogen dioxide";
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-07-15",
    siteRef: "NCA3",
    csvText: [
      "All Data GMT hour ending",
      `Date,time,"${sourceLabel}",status,unit`,
      "14-07-2026,24:00,,,",
      "15-07-2026,01:00,not-a-number,P,ugm-3",
      "15-07-2026,02:00,-1.25,P,ugm-3",
    ].join("\n"),
    mappings: [{
      site_ref: "NCA3",
      uk_air_ref: "UKA00528",
      pollutant_code: "no2",
      station_id: 1768,
      timeseries_id: 529,
      station_ref: "1038",
      timeseries_ref: "363",
      valid_from_day_utc: null,
      valid_to_day_utc: null,
    }],
    propertyMappings: [propertyMapping(sourceLabel, "no2")],
  });

  assertEquals(parsed.rows.map((row) => ({
    observed_at: row.observed_at,
    value: row.value,
    status: row.status,
  })), [{
    observed_at: "2026-07-15T02:00:00.000Z",
    value: -1.25,
    status: "P",
  }]);
  assertEquals(parsed.mapped_records, 1);
});

Deno.test("UK-AIR CSV mapping switches timeseries at the EA8 validity boundary", () => {
  const mappings = [
    {
      site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "pm10" as const,
      station_id: 1, timeseries_id: 66, station_ref: "station-ea8",
      timeseries_ref: "timeseries-old", valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: "2026-05-17",
    },
    {
      site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "pm10" as const,
      station_id: 1, timeseries_id: 95, station_ref: "station-ea8",
      timeseries_ref: "timeseries-new", valid_from_day_utc: "2026-05-18",
      valid_to_day_utc: null,
    },
  ];
  const csvText = [
    "Station metadata",
    "All Data GMT hour ending ",
    'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
    "17-05-2026,01:00,10,R,ugm-3",
    "18-05-2026,01:00,11,R,ugm-3",
  ].join("\n");

  const propertyMappings = [propertyMapping("PM<sub>10</sub> particulate matter (Hourly measured)", "pm10")];
  const before = parseUkAirFlatFileObservations({ dayUtc: "2026-05-17", siteRef: "EA8", csvText, mappings, propertyMappings });
  const after = parseUkAirFlatFileObservations({ dayUtc: "2026-05-18", siteRef: "EA8", csvText, mappings, propertyMappings });

  assertEquals(before.rows.map((row) => row.timeseries_id), [66]);
  assertEquals(after.rows.map((row) => row.timeseries_id), [95]);
});

Deno.test("UK-AIR CSV repair fails closed for ambiguous mappings", () => {
  let message = "";
  try {
    parseUkAirFlatFileObservations({
      dayUtc: "2026-05-17",
      siteRef: "EA8",
      csvText: [
        "Station metadata",
        "All Data GMT hour ending ",
        'Date,time,"Nitrogen dioxide (Hourly measured)",status,unit',
        "17-05-2026,01:00,10,R,ugm-3",
      ].join("\n"),
      mappings: [1, 2].map((timeseriesId) => ({
        site_ref: "EA8", uk_air_ref: "EA8", pollutant_code: "no2" as const,
        station_id: 1, timeseries_id: timeseriesId, station_ref: "station-ea8",
        timeseries_ref: `timeseries-${timeseriesId}`,
        valid_from_day_utc: "2020-01-01", valid_to_day_utc: null,
      })),
      propertyMappings: [propertyMapping("Nitrogen dioxide (Hourly measured)", "no2")],
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("matches=2")) throw new Error(`Expected ambiguous mapping failure, got: ${message}`);
});

Deno.test("UK-AIR CSV skips selected rows when no authoritative timeseries binding exists", () => {
  const sourceLabel = "PM<sub>10</sub> particulate matter (Hourly measured)";
  const normalisedSourceLabel = sourceLabel.toLowerCase();
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-07-18",
    siteRef: "HG4",
    csvText: [
      "Station metadata",
      "All Data GMT hour ending",
      `Date,time,"${sourceLabel}",status,unit`,
      "18-07-2026,01:00,10,R,ugm-3",
      "18-07-2026,02:00,11,R,ugm-3",
      "19-07-2026,01:00,12,R,ugm-3",
    ].join("\n"),
    mappings: [],
    propertyMappings: [propertyMapping(sourceLabel, "pm10")],
    registryEntries: new Map([[normalisedSourceLabel, {
      normalised_source_label: normalisedSourceLabel,
      status: "mapped",
      pollutant_code: "pm10",
      expected_uom: "ug/m3",
      raw_label_variants: [sourceLabel],
      observed_units: ["ugm-3"],
      reviewed_at_utc: "2026-07-18T00:00:00Z",
      review_notes: null,
    }]]),
  });

  assertEquals(parsed.rows, []);
  assertEquals(parsed.mapped_records, 0);
  assertEquals(parsed.selected_source_records_examined, 2);
  assertEquals(parsed.missing_binding_groups, 1);
  assertEquals(parsed.missing_binding_rows, 2);
  assertEquals(parsed.source_label_classifications, [{
    source_label: sourceLabel,
    normalised_source_label: normalisedSourceLabel,
    classification: "no_authoritative_timeseries_binding",
    reason: "no_authoritative_timeseries_binding",
    site_ref: "HG4",
    pollutant_code: "pm10",
    observed_units: ["ugm-3"],
    target_day_non_null_row_count: 2,
    target_day_blank_unit_row_count: 0,
    header_section_index: 1,
    section_normalised_units: ["ug/m3"],
    expected_unit: "ug/m3",
    expected_normalised_unit: "ug/m3",
    possible_supported_pollutant_label: false,
  }]);
});

Deno.test("UK-AIR selected source count includes mapped and missing-binding rows", () => {
  const pm10Label = "PM<sub>10</sub> particulate matter (Hourly measured)";
  const no2Label = "Nitrogen dioxide (Hourly measured)";
  const registryEntries = new Map([
    [pm10Label.toLowerCase(), {
      normalised_source_label: pm10Label.toLowerCase(),
      status: "mapped" as const,
      pollutant_code: "pm10",
      expected_uom: "ug/m3",
      raw_label_variants: [pm10Label],
      observed_units: ["ugm-3"],
      reviewed_at_utc: "2026-07-18T00:00:00Z",
      review_notes: null,
    }],
    [no2Label.toLowerCase(), {
      normalised_source_label: no2Label.toLowerCase(),
      status: "mapped" as const,
      pollutant_code: "no2",
      expected_uom: "ug/m3",
      raw_label_variants: [no2Label],
      observed_units: ["ugm-3"],
      reviewed_at_utc: "2026-07-18T00:00:00Z",
      review_notes: null,
    }],
  ]);
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-07-18",
    siteRef: "HG4",
    csvText: [
      "All Data GMT hour ending",
      `Date,time,"${pm10Label}",status,unit,"${no2Label}",status,unit`,
      "18-07-2026,01:00,10,R,ugm-3,20,R,ugm-3",
      "18-07-2026,02:00,11,R,ugm-3,21,R,ugm-3",
    ].join("\n"),
    mappings: [{
      site_ref: "HG4",
      uk_air_ref: "HG4",
      pollutant_code: "no2",
      station_id: 10,
      timeseries_id: 20,
      station_ref: "station-hg4",
      timeseries_ref: "timeseries-hg4-no2",
      valid_from_day_utc: "2020-01-01",
      valid_to_day_utc: null,
    }],
    propertyMappings: [
      propertyMapping(pm10Label, "pm10"),
      propertyMapping(no2Label, "no2"),
    ],
    registryEntries,
  });

  assertEquals(parsed.mapped_records, 2);
  assertEquals(parsed.missing_binding_rows, 2);
  assertEquals(parsed.selected_source_records_examined, 4);
  assertEquals(parsed.rows.length, 2);
});

Deno.test("UK-AIR CSV registry and core mapping contradiction remains fail closed", () => {
  const sourceLabel = "PM<sub>10</sub> particulate matter (Hourly measured)";
  const normalisedSourceLabel = sourceLabel.toLowerCase();
  let message = "";
  try {
    parseUkAirFlatFileObservations({
      dayUtc: "2026-07-18",
      siteRef: "HG4",
      csvText: [
        "All Data GMT hour ending",
        `Date,time,"${sourceLabel}",status,unit`,
        "18-07-2026,01:00,10,R,ugm-3",
      ].join("\n"),
      mappings: [],
      propertyMappings: [propertyMapping(sourceLabel, "no2")],
      registryEntries: new Map([[normalisedSourceLabel, {
        normalised_source_label: normalisedSourceLabel,
        status: "mapped",
        pollutant_code: "pm10",
        expected_uom: "ug/m3",
        raw_label_variants: [sourceLabel],
        observed_units: ["ugm-3"],
        reviewed_at_utc: "2026-07-18T00:00:00Z",
        review_notes: null,
      }]]),
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("sos_source_label_registry_mapping_mismatch")) {
    throw new Error(`Expected registry/core mapping contradiction, got: ${message}`);
  }
});

Deno.test("UK-AIR CSV parses every mapped pollutant triplet", () => {
  const labels = [
    ["Ozone", "o3"],
    ["Nitric oxide", "no"],
    ["Nitrogen oxides as nitrogen dioxide", "nox_as_no2"],
    ["Sulphur dioxide", "so2"],
    ["Carbon monoxide", "co"],
  ] as const;
  const mappings = labels.map(([, code], index) => ({
    site_ref: "MULTI", uk_air_ref: "MULTI", pollutant_code: code,
    station_id: 10, timeseries_id: 100 + index, station_ref: "station-multi",
    timeseries_ref: `timeseries-${code}`, valid_from_day_utc: null,
    valid_to_day_utc: null,
  }));
  const header = ["Date", "time", ...labels.flatMap(([label]) => [label, "status", "unit"])];
  const row = ["17-05-2026", "01:00", ...labels.flatMap((_, index) => [String(index + 1), "R", "ugm-3"])];
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "MULTI",
    csvText: ["All Data GMT hour ending", header.join(","), row.join(",")].join("\n"),
    mappings,
    propertyMappings: labels.map(([label, code]) => propertyMapping(label, code)),
  });
  assertEquals(parsed.rows.map((item) => item.pollutant_code), labels.map(([, code]) => code));
  assertEquals(parsed.rows.map((item) => item.value), [1, 2, 3, 4, 5]);
});

Deno.test("UK-AIR CSV fails closed for an unmapped source label", () => {
  let message = "";
  try {
    parseUkAirFlatFileObservations({
      dayUtc: "2026-05-17",
      siteRef: "EA8",
      csvText: [
        "All Data GMT hour ending",
        "Date,time,Ozone,status,unit",
        "17-05-2026,01:00,1,R,ugm-3",
      ].join("\n"),
      mappings: [],
      propertyMappings: [],
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("unmapped_source_label")) throw new Error(message);
});

Deno.test("UK-AIR CSV ignores only explicitly ignored source labels", () => {
  const parsed = parseUkAirFlatFileObservations({
    dayUtc: "2026-05-17",
    siteRef: "EA8",
    csvText: [
      "All Data GMT hour ending",
      "Date,time,Instrument note,status,unit",
      "17-05-2026,01:00,1,R,text",
    ].join("\n"),
    mappings: [],
    propertyMappings: [{
      connector_id: 1, source_label: "Instrument note", source_uom: null,
      observed_property_id: null, observed_property_code: null,
      mapping_kind: "ignored", is_aqi_eligible: false, is_active: true,
    }],
  });
  assertEquals(parsed.rows, []);
  assertEquals(parsed.skipped_ignored_properties, 1);
});

Deno.test("AQI part summary counts valid timeseries ids only", () => {
  const summary = summarizeAqilevelsPartRows([
    { timeseries_id: 123, timestamp_hour_utc: "2026-06-01T00:00:00.000Z", pollutant_code: "no2" },
    { timeseries_id: 123, timestamp_hour_utc: "2026-06-01T01:00:00.000Z", pollutant_code: "no2" },
    { timeseries_id: 124, timestamp_hour_utc: "2026-06-01T00:00:00.000Z", pollutant_code: "pm25" },
    { timeseries_id: 0, timestamp_hour_utc: "2026-06-01T02:00:00.000Z", pollutant_code: "pm10" },
    { timeseries_id: null, timestamp_hour_utc: "2026-06-01T03:00:00.000Z", pollutant_code: "pm10" },
    { timeseries_id: Number.NaN, timestamp_hour_utc: "2026-06-01T04:00:00.000Z", pollutant_code: "pm10" },
  ] as never);

  assertEquals(summary.min_timeseries_id, 123);
  assertEquals(summary.max_timeseries_id, 124);
  assertEquals(summary.timeseries_row_counts, { "123": 2, "124": 1 });
});

Deno.test("AQI v2 pollutant and connector manifests expose aggregated top-level timeseries row counts", () => {
  const no2Manifest = createAqiV2PollutantManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    pollutantCode: "no2",
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/manifest.json",
    sourceRowCount: 3,
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
    fileEntries: [
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=no2/part-00000.parquet",
        row_count: 3,
        bytes: 100,
        etag_or_hash: "etag-no2",
        min_timeseries_id: 123,
        max_timeseries_id: 124,
        min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-01T01:00:00.000Z",
        timeseries_row_counts: { "123": 2, "124": 1 },
      },
    ],
  });
  const pm25Manifest = createAqiV2PollutantManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    pollutantCode: "pm25",
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=pm25/manifest.json",
    sourceRowCount: 2,
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
    fileEntries: [
      {
        key: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/pollutant_code=pm25/part-00000.parquet",
        row_count: 2,
        bytes: 90,
        etag_or_hash: "etag-pm25",
        min_timeseries_id: 123,
        max_timeseries_id: 125,
        min_timestamp_hour_utc: "2026-06-01T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-06-01T01:00:00.000Z",
        timeseries_row_counts: { "123": 1, "125": 1 },
      },
    ],
  });

  assertEquals(no2Manifest.timeseries_row_counts, { "123": 2, "124": 1 });
  assertEquals((no2Manifest.files as Array<Record<string, unknown>>)[0].timeseries_row_counts, undefined);
  assertEquals(
    Object.values(no2Manifest.timeseries_row_counts as Record<string, number>).reduce((sum, value) => sum + value, 0),
    no2Manifest.source_row_count,
  );

  const connectorManifest = createAqiV2ConnectorManifest({
    profile: "data",
    dayUtc: "2026-06-01",
    connectorId: 6,
    runId: "run-1",
    manifestKey: "history/v2/aqilevels/hourly/data/day_utc=2026-06-01/connector_id=6/manifest.json",
    pollutantManifests: [no2Manifest, pm25Manifest],
    writerGitSha: null,
    backedUpAtUtc: "2026-06-02T00:00:00.000Z",
  });

  assertEquals(connectorManifest.timeseries_row_counts, { "123": 3, "124": 1, "125": 1 });
  assertEquals(
    Object.values(connectorManifest.timeseries_row_counts as Record<string, number>).reduce((sum, value) => sum + value, 0),
    connectorManifest.source_row_count,
  );
});
