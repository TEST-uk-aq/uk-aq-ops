import assert from "node:assert/strict";
import {
  buildMetadataIndex,
  buildSourceRows,
  coreMetadataTableKeys,
  metadataCacheRepresentsLatestCoreManifest,
  normalizeCoreMetadataCacheFile,
  validateSnapshotContractPaths,
} from "./run_job.ts";

function fixtureMetadata() {
  return buildMetadataIndex({
    schema_version: 2,
    generated_at: "2026-06-29T00:00:00.000Z",
    source_day_utc: "2026-06-29",
    connectors: [{
      id: 10,
      connector_code: "bl",
      label: "Breathe London connector",
      display_name: "Breathe London",
      station_display_name_template: null,
    }],
    stations: [{
      id: 20,
      connector_id: 10,
      network_id: 30,
      match_id: 70,
      station_ref: "BL-001",
      label: "BL Node 001",
      station_name: "BL Node 001",
      pcon_code: "E14000001",
      la_code: null,
      removed_at: null,
    }, {
      id: 21,
      connector_id: 1,
      network_id: 31,
      match_id: 70,
      station_ref: "AURN-001",
      label: "AURN Node 001",
      station_name: "AURN Node 001",
      pcon_code: "E14000001",
      la_code: null,
      removed_at: null,
    }],
    networks: [{
      id: 30,
      network_code: "breathelondon",
      display_name: "Breathe London Nodes",
      network_type: "community",
      public_display_enabled: true,
    }, {
      id: 31,
      network_code: "gov_uk_aurn",
      display_name: "GOV.UK AURN",
      network_type: "official",
      public_display_enabled: true,
    }],
    station_matches: [{
      id: 70,
      uk_air_ref: "UKA01234",
      match_name: "Canonical Site",
    }],
    timeseries: [{
      id: 40,
      connector_id: 10,
      station_id: 20,
      phenomenon_id: 50,
      label: "PM2.5 - BL Node 001",
      uom: "ug/m3",
    }],
    phenomena: [{
      id: 50,
      observed_property_id: 60,
      label: "PM2.5",
      notation: "pm25",
      pollutant_label: "PM2.5",
      source_label: null,
    }],
    observed_properties: [{
      id: 60,
      code: "pm25",
      display_name: "PM2.5",
    }],
  });
}

function fixtureState() {
  return new Map([["10:40", {
    connector_id: 10,
    timeseries_id: 40,
    observed_at: "2026-06-29T01:00:00.000Z",
    value: 12.3,
    value_float8_hex: null,
    status: null,
    ingested_at: "2026-06-29T01:01:00.000Z",
  }]]);
}

Deno.test("v2 latest rows expose additive canonical site fields and scalar source provenance", () => {
  const result = buildSourceRows(fixtureState(), fixtureMetadata(), "v2");
  assert.equal(result.missingMetadata, 0);
  assert.equal(result.rows.length, 1);
  const item = result.rows[0].item as Record<string, unknown>;

  assert.equal(item.network_id, 30);
  assert.equal(item.network_code, "breathelondon");
  assert.equal(item.network_label, "Breathe London Nodes");
  assert.equal(item.connector_id, 10);
  assert.equal(item.connector_code, "bl");
  assert.equal(item.connector_label, "Breathe London");
  assert.equal(item.match_id, 70);
  assert.equal(item.uk_air_ref, "UKA01234");
  assert.equal(item.canonical_station_label, "Canonical Site");
  assert.deepEqual(item.site_networks, [{
    network_id: 30,
    network_code: "breathelondon",
    network_label: "Breathe London Nodes",
  }, {
    network_id: 31,
    network_code: "gov_uk_aurn",
    network_label: "GOV.UK AURN",
  }]);

  assert.equal(Object.hasOwn(item, "station_network_memberships"), false);
  assert.equal(Object.hasOwn(item, "network_memberships"), false);
  assert.equal(Object.hasOwn(item, "network_name"), false);
  assert.equal(Object.hasOwn(item, "network_type"), false);
});

Deno.test("matched latest rows retain match identity when UK-AIR identity is unavailable", () => {
  const metadata = fixtureMetadata();
  metadata.stationMatchesById.set(70, {
    id: 70,
    uk_air_ref: null,
    match_name: "Legacy non-canonical match",
  });
  const result = buildSourceRows(fixtureState(), metadata, "v2");
  const item = result.rows[0].item as Record<string, unknown>;

  assert.equal(item.match_id, 70);
  assert.equal(item.uk_air_ref, null);
  assert.equal(item.canonical_station_label, "Legacy non-canonical match");
  assert.deepEqual(item.site_networks, [{
    network_id: 30,
    network_code: "breathelondon",
    network_label: "Breathe London Nodes",
  }, {
    network_id: 31,
    network_code: "gov_uk_aurn",
    network_label: "GOV.UK AURN",
  }]);
});

Deno.test("unmatched latest rows expose null canonical fields and one scalar site network", () => {
  const metadata = fixtureMetadata();
  const station = metadata.stationsById.get(20);
  if (!station) throw new Error("fixture station missing");
  station.match_id = null;
  const result = buildSourceRows(fixtureState(), metadata, "v2");
  const item = result.rows[0].item as Record<string, unknown>;

  assert.equal(item.match_id, null);
  assert.equal(item.uk_air_ref, null);
  assert.equal(item.canonical_station_label, null);
  assert.deepEqual(item.site_networks, [{
    network_id: 30,
    network_code: "breathelondon",
    network_label: "Breathe London Nodes",
  }]);
});

Deno.test("older core metadata without station_matches remains a valid empty canonical projection", () => {
  const fixture = {
    schema_version: 2,
    generated_at: "2026-10-03T12:00:00.000Z",
    source_day_utc: "2026-10-03",
    connectors: [],
    stations: [],
    networks: [],
    timeseries: [],
    phenomena: [],
    observed_properties: [],
  };

  const normalized = normalizeCoreMetadataCacheFile(fixture);

  assert.ok(normalized);
  assert.deepEqual(normalized.station_matches, []);
  assert.equal(metadataCacheRepresentsLatestCoreManifest(normalized, {
    day_utc: "2026-10-03",
    key: "history/v2/core/day_utc=2026-10-03/manifest.json",
    last_modified: "2026-10-03T12:01:00.000Z",
  }), false);
});

Deno.test("older core manifest may omit the additive station_matches table", () => {
  const keys = coreMetadataTableKeys({
    day_utc: "2026-10-02",
    tables: [
      { table: "connectors", key: "core/connectors.ndjson" },
      { table: "networks", key: "core/networks.ndjson" },
      { table: "stations", key: "core/stations.ndjson" },
      { table: "timeseries", key: "core/timeseries.ndjson" },
      { table: "phenomena", key: "core/phenomena.ndjson" },
      { table: "observed_properties", key: "core/observed_properties.ndjson" },
    ],
  });

  assert.equal(keys.has("station_matches"), false);
});

Deno.test("core metadata uses station_matches when the additive table is present", () => {
  const keys = coreMetadataTableKeys({
    day_utc: "2026-10-03",
    tables: [
      { table: "connectors", key: "core/connectors.ndjson" },
      { table: "networks", key: "core/networks.ndjson" },
      { table: "stations", key: "core/stations.ndjson" },
      { table: "station_matches", key: "core/station_matches.ndjson" },
      { table: "timeseries", key: "core/timeseries.ndjson" },
      { table: "phenomena", key: "core/phenomena.ndjson" },
      { table: "observed_properties", key: "core/observed_properties.ndjson" },
    ],
  });

  assert.equal(keys.get("station_matches"), "core/station_matches.ndjson");
});

Deno.test("removed matched stations do not contribute current canonical memberships", () => {
  const metadata = fixtureMetadata();
  const regionalStation = metadata.stationsById.get(20);
  const aurnStation = metadata.stationsById.get(21);
  if (!regionalStation || !aurnStation) throw new Error("fixture stations missing");
  regionalStation.removed_at = "2026-10-01T00:00:00.000Z";
  aurnStation.removed_at = "2026-10-01T00:00:00.000Z";

  const rebuilt = buildMetadataIndex({
    schema_version: 2,
    generated_at: "2026-06-29T00:00:00.000Z",
    source_day_utc: "2026-06-29",
    connectors: [...metadata.connectorsById.values()],
    stations: [...metadata.stationsById.values()],
    station_matches: [...metadata.stationMatchesById.values()],
    networks: [...metadata.networksById.values()],
    timeseries: [...metadata.timeseriesById.values()],
    phenomena: [...metadata.phenomenaById.values()],
    observed_properties: [...metadata.observedPropertyById.values()],
  });
  const item = buildSourceRows(fixtureState(), rebuilt, "v2").rows[0].item as Record<string, unknown>;

  assert.deepEqual(item.site_networks, []);
});

Deno.test("current canonical memberships exclude only the removed source network", () => {
  const metadata = fixtureMetadata();
  const regionalStation = metadata.stationsById.get(20);
  if (!regionalStation) throw new Error("fixture station missing");
  regionalStation.removed_at = "2026-10-01T00:00:00.000Z";

  const rebuilt = buildMetadataIndex({
    schema_version: 2,
    generated_at: "2026-06-29T00:00:00.000Z",
    source_day_utc: "2026-06-29",
    connectors: [...metadata.connectorsById.values()],
    stations: [...metadata.stationsById.values()],
    station_matches: [...metadata.stationMatchesById.values()],
    networks: [...metadata.networksById.values()],
    timeseries: [...metadata.timeseriesById.values()],
    phenomena: [...metadata.phenomenaById.values()],
    observed_properties: [...metadata.observedPropertyById.values()],
  });
  const item = buildSourceRows(fixtureState(), rebuilt, "v2").rows[0].item as Record<string, unknown>;

  assert.deepEqual(item.site_networks, [{
    network_id: 31,
    network_code: "gov_uk_aurn",
    network_label: "GOV.UK AURN",
  }]);
});

Deno.test("missing station network metadata is counted and skipped", () => {
  const metadata = fixtureMetadata();
  metadata.networksById.clear();
  const result = buildSourceRows(fixtureState(), metadata, "v2");
  assert.equal(result.missingMetadata, 1);
  assert.equal(result.rows.length, 0);
});


Deno.test("contract path validation rejects obvious v2/v1 cross-version paths", () => {
  assert.throws(() => validateSnapshotContractPaths("v2", [
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "latest_snapshots/v1" },
  ]), /UK_AQ_LATEST_SNAPSHOT_R2_PREFIX=latest_snapshots\/v1/);
  assert.throws(() => validateSnapshotContractPaths("v2", [
    { name: "UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY", value: "latest_snapshots/v1/manifest.json" },
  ]), /UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY=latest_snapshots\/v1\/manifest.json/);
  assert.throws(() => validateSnapshotContractPaths("v2", [
    { name: "UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX", value: "latest_snapshots/v1/_runs" },
  ]), /UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX=latest_snapshots\/v1\/_runs/);
});

Deno.test("contract path validation allows matching version and custom paths", () => {
  validateSnapshotContractPaths("v2", [
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "latest_snapshots/v2" },
    { name: "UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY", value: "latest_snapshots/v2/manifest.json" },
    { name: "UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX", value: "latest_snapshots/v2/_runs" },
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "custom/latest" },
  ]);
});
