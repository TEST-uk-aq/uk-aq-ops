import assert from "node:assert/strict";
import {
  buildMetadataIndex,
  buildSourceRows,
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
      station_ref: "BL-001",
      label: "BL Node 001",
      station_name: "BL Node 001",
      pcon_code: "E14000001",
      la_code: null,
    }],
    networks: [{
      id: 30,
      network_code: "breathe_london",
      display_name: "Breathe London Nodes",
      network_type: "community",
      public_display_enabled: true,
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

Deno.test("v2 latest rows expose scalar public network fields and no membership fields", () => {
  const result = buildSourceRows(fixtureState(), fixtureMetadata(), "v2");
  assert.equal(result.missingMetadata, 0);
  assert.equal(result.rows.length, 1);
  const item = result.rows[0].item as Record<string, unknown>;

  assert.equal(item.network_id, 30);
  assert.equal(item.network_code, "breathe_london");
  assert.equal(item.network_label, "Breathe London Nodes");
  assert.equal(item.connector_code, "bl");
  assert.equal(item.connector_label, "Breathe London");

  assert.equal(Object.hasOwn(item, "station_network_memberships"), false);
  assert.equal(Object.hasOwn(item, "network_memberships"), false);
  assert.equal(Object.hasOwn(item, "network_name"), false);
  assert.equal(Object.hasOwn(item, "network_type"), false);
});

Deno.test("v1 latest rows retain station_network_memberships compatibility", () => {
  const result = buildSourceRows(fixtureState(), fixtureMetadata(), "v1");
  assert.equal(result.missingMetadata, 0);
  assert.equal(result.rows.length, 1);
  const item = result.rows[0].item as Record<string, unknown>;

  assert.deepEqual(item.station_network_memberships, [{
    network_code: "breathe_london",
    network_label: "Breathe London Nodes",
    is_primary: true,
  }]);
  assert.equal(Object.hasOwn(item, "network_id"), false);
  assert.equal(Object.hasOwn(item, "network_code"), false);
  assert.equal(Object.hasOwn(item, "network_label"), false);
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
  assert.throws(() => validateSnapshotContractPaths("v1", [
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "latest_snapshots/v2" },
  ]), /UK_AQ_LATEST_SNAPSHOT_R2_PREFIX=latest_snapshots\/v2/);
  assert.throws(() => validateSnapshotContractPaths("v1", [
    { name: "UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY", value: "latest_snapshots/v2/manifest.json" },
  ]), /UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY=latest_snapshots\/v2\/manifest.json/);
  assert.throws(() => validateSnapshotContractPaths("v1", [
    { name: "UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX", value: "latest_snapshots/v2/_runs" },
  ]), /UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX=latest_snapshots\/v2\/_runs/);
});

Deno.test("contract path validation allows matching version and custom paths", () => {
  validateSnapshotContractPaths("v2", [
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "latest_snapshots/v2" },
    { name: "UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY", value: "latest_snapshots/v2/manifest.json" },
    { name: "UK_AQ_LATEST_SNAPSHOT_RUNS_PREFIX", value: "latest_snapshots/v2/_runs" },
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "custom/latest" },
  ]);
  validateSnapshotContractPaths("v1", [
    { name: "UK_AQ_LATEST_SNAPSHOT_R2_PREFIX", value: "latest_snapshots/v1" },
    { name: "UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY", value: "legacy/latest/manifest.json" },
  ]);
});
