import assert from "node:assert/strict";
import test from "node:test";
import { deriveMonthlyProduct, derivationIdentity, fingerprint, profilesForMonth, validatePrevious } from "../scripts/ukair_bc/bc_uv_diurnal_incremental.mjs";

// Small deterministic checks for the stale-reuse/publication boundary. No R2 or
// database operations: readDay stands in for the already-verified shared reader.
const station = { station_id: 1, station_ref: "UKA00001", name: "Example", latitude: 52, longitude: -1,
  timeseries_ids: { bc: 11, uv370: 12 } };
const stations = [station];
const identity = (selected = stations) => derivationIdentity({ connectorId: 7, stations: selected,
  prefix: "history/v3/observations", implementationHash: "a".repeat(64) });
function pair(time, bc, uv, status = "R", selected = station) {
  const row = (property, value) => ({ station_id: selected.station_id, timeseries_id: selected.timeseries_ids[property], pollutant_code: property,
    observed_at_utc: time, value, verification_status: status });
  return { bcRows: [row("bc", bc)], uvRows: [row("uv370", uv)] };
}
function source() {
  return new Map([
    ["2024-01-01", pair("2024-01-01T01:00:00.000Z", 5, 3)],
    ["2024-01-02", pair("2024-01-02T01:00:00.000Z", 4, 4, "P")],
    ["2024-02-01", pair("2024-02-01T00:00:00.000Z", 6, 4)],
    ["2024-02-05", pair("2024-02-05T01:00:00.000Z", 2, 3)],
    ["2024-03-01", pair("2024-03-01T00:00:00.000Z", 3, 4)],
  ]);
}
async function build(data, previous = null, options = {}) {
  const reads = [];
  const result = await deriveMonthlyProduct({ days: [...data].sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) =>
    ({ day_utc: day, manifest_hash: fingerprint(rows) })), previous, derivation: identity(options.stations),
    stations: options.stations || stations, generatedAt: "2024-03-02T00:00:00.000Z", ...options,
    readDay: async ({ day_utc }) => { reads.push(day_utc); return data.get(day_utc); } });
  return { ...result, reads };
}

test("bootstrap binds full history; unchanged run reads no canonical day and retains identical bytes", async () => {
  const data = source();
  const first = await build(data);
  assert.equal(first.mode, "full_bootstrap");
  assert.equal(first.canonical_days, 5);
  assert.deepEqual(first.product.months.map((m) => m.month), ["2024-01", "2024-02"]);
  assert.equal(first.product.source_through_day, "2024-02-29");
  const profile = first.product.sensors[0].profiles.uvpm[0];
  assert.equal(profile.points[0].mean_ugm3, -1);
  assert.equal(profile.points[0].observation_count, 2);
  assert.equal(profile.points[0].provisional_count, 1);
  assert.equal(profile.points[23].mean_ugm3, -2);
  const second = await build(data, first.product, { generatedAt: "2024-03-03T00:00:00.000Z" });
  assert.equal(second.mode, "no_op");
  assert.equal(second.months_reused, 3); // Includes the verified empty trailing month.
  assert.equal(second.canonical_days, 0);
  assert.deepEqual(second.reads, []);
  assert.equal(JSON.stringify(second.product), JSON.stringify(first.product));
});

test("next-month midnight correction rechecks both dependencies but rebuilds only the affected source month", async () => {
  const data = source();
  const first = await build(data);
  data.set("2024-03-01", pair("2024-03-01T00:00:00.000Z", 3, 0, "P"));
  const next = await build(data, first.product);
  assert.deepEqual(next.rebuilt_months, ["2024-02"]);
  assert.equal(next.months_reused, 2);
  assert.deepEqual(next.reads, ["2024-02-01", "2024-02-05", "2024-03-01"]);
  const point = next.product.sensors[0].profiles.uvpm[1].points[23];
  assert.equal(point.mean_ugm3, -3);
  assert.equal(point.provisional_count, 1);
  assert.equal(point.source_validation_status, "P");
  assert.deepEqual(next.product.sensors[0].profiles.bc[0], first.product.sensors[0].profiles.bc[0]);
});

test("missing next-day dependency becoming present rebuilds the preceding month", async () => {
  const data = source();
  data.delete("2024-03-01");
  const first = await build(data);
  assert.equal(first.product.incremental_provenance.months[1].dependencies.at(-1).manifest_hash, null);
  data.set("2024-03-01", pair("2024-03-01T00:00:00.000Z", 3, 3));
  const next = await build(data, first.product);
  assert.deepEqual(next.rebuilt_months, ["2024-02", "2024-03"]);
  assert.equal(next.product.sensors[0].profiles.uvpm[1].points[23].mean_ugm3, 0);
  assert.equal(next.product.source_through_day, "2024-02-29");
});

test("removal of latest endpoint retreats source-through and recalculates completeness", async () => {
  const data = source();
  const first = await build(data);
  data.delete("2024-03-01");
  const next = await build(data, first.product);
  assert.deepEqual(next.rebuilt_months, ["2024-02"]);
  assert.equal(next.product.source_through_day, "2024-02-05");
  assert.equal(next.product.months[1].expected_source_days, 5);
  assert.equal(next.product.months[1].complete_calendar_month, false);
  assert.equal(next.product.sensors[0].profiles.bc[1].points[23].observation_count, 0);
  assert.equal(next.product.sensors[0].profiles.bc[1].observed_source_days, 1);
  assert.equal((await build(data, next.product)).mode, "no_op");
});

test("historical P-to-R changes invalidate that month and recompute contributor status", async () => {
  const data = source();
  const first = await build(data);
  data.set("2024-01-02", pair("2024-01-02T01:00:00.000Z", 4, 4));
  const next = await build(data, first.product);
  assert.deepEqual(next.rebuilt_months, ["2024-01"]);
  assert.equal(next.product.sensors[0].profiles.uvpm[0].points[0].ratified_count, 2);
  assert.equal(next.product.sensors[0].profiles.uvpm[0].points[0].source_validation_status, "R");
});

test("population expansion reuses peers, reads historical rows for the added station and proves empty months", async () => {
  const data = source();
  const added = { ...station, station_id: 2, station_ref: "UKA00002", timeseries_ids: { bc: 21, uv370: 22 } };
  const historical = pair("2024-02-05T02:00:00.000Z", 3, 1, "P", added);
  for (const property of ["bcRows", "uvRows"]) data.get("2024-02-05")[property].push(...historical[property]);
  const first = await build(data);
  const expanded = await build(data, first.product, { stations: [added, station] });
  assert.deepEqual(expanded.reads, ["2024-02-01", "2024-02-05", "2024-03-01"]);
  assert.equal(expanded.newly_eligible_stations, 1);
  assert.equal(expanded.station_months_reused, 3);
  assert.equal(expanded.station_months_rebuilt, 3);
  assert.equal(expanded.station_months_built_from_absence, 2);
  assert.equal(expanded.months_reused, 0);
  assert.ok(expanded.fallback_reasons.includes("unbaselined_series_present"));
  assert.deepEqual(expanded.product, (await build(data, first.product, { stations: [added, station], fullRebuild: true })).product);

  const boundary = pair("2024-03-01T00:00:00.000Z", 4, 1, "P", added);
  for (const property of ["bcRows", "uvRows"]) data.get("2024-03-01")[property].push(...boundary[property]);
  const corrected = await build(data, expanded.product, { stations: [added, station] });
  assert.equal(corrected.station_months_rebuilt, 1);
  assert.equal(corrected.station_months_reused, 5);
  assert.deepEqual(corrected.rebuilt_months, ["2024-02"]);
  assert.deepEqual(corrected.product, (await build(data, expanded.product, { stations: [added, station], fullRebuild: true })).product);

  const retired = await build(data, corrected.product, { stations: [station] });
  assert.equal(retired.retired_stations, 1);
  assert.equal(retired.station_months_reused, 3);
  assert.deepEqual(retired.reads, []);
  assert.deepEqual(retired.product.sensors, first.product.sensors);
});

test("legacy and forced builds read all months, while metadata-only edits retain proven profiles", async () => {
  const data = source();
  const first = await build(data);
  const legacy = structuredClone(first.product);
  delete legacy.incremental_provenance;
  assert.equal(validatePrevious(legacy), null);
  const monthlyOnly = structuredClone(first.product);
  monthlyOnly.incremental_provenance.schema_version = 1;
  monthlyOnly.incremental_provenance.months = monthlyOnly.incremental_provenance.months.map(
    ({ stations: _proofs, observed_timeseries_ids: _ids, ...record }) => ({
      ...record, profiles_sha256: fingerprint(profilesForMonth(first.product, stations, record.month)),
    }));
  assert.equal(validatePrevious(monthlyOnly).schema_version, 1);
  for (const options of [{ previous: legacy }, { previous: monthlyOnly }, { fullRebuild: true },
    { derivation: { ...identity(), implementation_sha256: "b".repeat(64) } }]) {
    const { previous = first.product, ...rest } = options;
    const result = await build(data, previous, rest);
    assert.equal(result.months_rebuilt, 3);
    assert.equal(result.months_reused, 0);
    assert.equal(result.canonical_days, 5);
  }
  const renamed = await build(data, first.product, { stations: [{ ...station, name: "Renamed" }] });
  assert.equal(renamed.mode, "incremental");
  assert.equal(renamed.station_months_reused, 3);
  assert.equal(renamed.canonical_days, 0);
  assert.equal(renamed.product.sensors[0].name, "Renamed");
  assert.deepEqual(renamed.product.sensors[0].profiles, first.product.sensors[0].profiles);
});

test("contradictory prior station-month evidence fails closed, including on a forced rebuild", async () => {
  const data = source();
  const first = await build(data);
  const bad = structuredClone(first.product);
  bad.sensors[0].profiles.bc[0].points[0].mean_ugm3 = 999;
  await assert.rejects(build(data, bad, { fullRebuild: true }), /profile provenance mismatch/);
  const badBoundary = structuredClone(first.product);
  badBoundary.incremental_provenance.months[0].dependencies.pop();
  await assert.rejects(build(data, badBoundary), /monthly dependencies/);
  const badComplete = structuredClone(first.product);
  badComplete.sensors[0].profiles.bc[0].complete = true;
  await assert.rejects(build(data, badComplete), /profile completeness/);
  const badInventory = structuredClone(first.product);
  badInventory.incremental_provenance.months[0].observed_timeseries_ids = [];
  await assert.rejects(build(data, badInventory), /contradictory BC\/UV station-month observation evidence/i);
});
