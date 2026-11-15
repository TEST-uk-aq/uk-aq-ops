import assert from "node:assert/strict";
import test from "node:test";
import { createAccumulator, sourceSlot, validateProduct } from "../scripts/ukair_bc/bc_uv_diurnal_product.mjs";

const station = { station_id: 1, station_ref: "UKA00001", name: "Example", latitude: 52, longitude: -1,
  timeseries_ids: { bc: 11, uv370: 12 } };
const row = (series, property, time, value, status = "R") => ({
  station_id: 1, timeseries_id: series, pollutant_code: property, observed_at_utc: time,
  value, verification_status: status,
});

test("exact pairs retain negative and zero UVPM, P/R provenance, and GMT midnight source month", () => {
  assert.deepEqual(sourceSlot("2024-04-01T00:00:00.000Z"), {
    source_day: "2024-03-31", month: "2024-03", hour_ending: 24,
  });
  const builder = createAccumulator([station], "2024-03");
  builder.addCanonicalDay([
    row(11, "bc", "2024-04-01T00:00:00.000Z", 5),
    row(11, "bc", "2024-04-01T01:00:00.000Z", 4, "P"),
    row(11, "bc", "2024-04-01T02:00:00.000Z", 9),
  ], [
    row(12, "uv370", "2024-04-01T00:00:00.000Z", 3),
    row(12, "uv370", "2024-04-01T01:00:00.000Z", 4),
    row(12, "uv370", "2024-04-01T03:00:00.000Z", 20),
  ]);
  const product = builder.finish("2024-04-02T12:00:00.000Z");
  validateProduct(product);
  assert.equal(product.source_through_day, "2024-04-01");
  assert.deepEqual(product.months.map(({ month, season, season_year }) => [month, season, season_year]), [
    ["2024-03", "Winter", 2023], ["2024-04", "Summer", 2024],
  ]);
  const sensor = product.sensors[0];
  assert.equal(sensor.profiles.uvpm[0].points[23].mean_ugm3, -2);
  assert.equal(sensor.profiles.uvpm[0].points[23].source_validation_status, "R");
  assert.equal(sensor.profiles.uvpm[1].points[0].mean_ugm3, 0);
  assert.equal(sensor.profiles.uvpm[1].points[0].provisional_count, 1);
  assert.equal(sensor.profiles.uvpm[1].points[1].observation_count, 0);
  assert.equal(sensor.profiles.bc[1].points[1].observation_count, 1);
});

test("ambiguous exact source identity fails generation", () => {
  const builder = createAccumulator([station], "2024-01");
  assert.throws(() => builder.addCanonicalDay([
    row(11, "bc", "2024-01-02T01:00:00.000Z", 1),
    row(11, "bc", "2024-01-02T01:00:00.000Z", 2),
  ], []), /Ambiguous exact observation pair/);
});

test("excluded newer station cannot advance public source-through day", () => {
  const second = { ...station, station_id: 2, station_ref: "UKA00002", timeseries_ids: { bc: 21, uv370: 22 } };
  const builder = createAccumulator([station, second], "2024-01");
  builder.addCanonicalDay([row(11, "bc", "2024-01-02T01:00:00.000Z", 1)], []);
  builder.addCanonicalDay([{ ...row(21, "bc", "2024-01-01T01:00:00.000Z", 2), station_id: 2 }], []);
  builder.addCanonicalDay([{ ...row(31, "bc", "2024-02-10T01:00:00.000Z", 3), station_id: 3 }], [
    { ...row(32, "uv370", "2024-02-10T01:00:00.000Z", 4), station_id: 3 },
  ]);
  const product = builder.finish("2024-02-11T00:00:00.000Z");
  assert.equal(product.source_through_day, "2024-01-02");
  assert.deepEqual(product.months.map(({ month }) => month), ["2024-01"]);
  assert.equal(product.sensors[0].profiles.bc[0].observed_source_days, 1);
  assert.equal(product.sensors[1].profiles.bc[0].observed_source_days, 1);
  assert.equal(product.sensors[1].profiles.bc[0].points[0].mean_ugm3, 2);
});
