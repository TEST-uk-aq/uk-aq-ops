import assert from "node:assert/strict";
import test from "node:test";
import { selectPublicStations } from "../scripts/ukair_bc/build_bc_uv_diurnal.mjs";

const station = (id, ref, overrides = {}) => ({
  station_id: String(id), station_ref: ref, name: `Station ${id}`,
  latitude: 53.5, longitude: -2.2, ...overrides,
});
const series = (id, stationId, ref, property, overrides = {}) => ({
  timeseries_id: id, station_id: String(stationId), timeseries_ref: `${ref}:${property}`,
  service_ref: "ukair_bc", uom: "ug/m3", property, ...overrides,
});

test("catalogue stations without BC/UV370 timeseries are excluded", () => {
  const rows = Array.from({ length: 30 }, (_, index) =>
    station(index + 1, index === 29 ? "UKA00248" : `UKA${String(index + 1).padStart(5, "0")}`));
  const timeseries = rows.slice(0, 25).flatMap((row, index) => [
    series(index * 2 + 1, row.station_id, row.station_ref, "bc"),
    series(index * 2 + 2, row.station_id, row.station_ref, "uv370"),
  ]);
  const selected = selectPublicStations(rows, timeseries);
  assert.equal(selected.length, 25);
  assert.ok(!selected.some((row) => row.station_ref === "UKA00248"));
  assert.deepEqual(selected[0].timeseries_ids, { bc: 1, uv370: 2 });
});

test("one supported property remains eligible and null coordinates fail", () => {
  const row = station(1, "UKA00001");
  const bc = series(11, 1, row.station_ref, "bc");
  assert.deepEqual(selectPublicStations([row], [bc])[0].timeseries_ids, { bc: 11, uv370: null });
  assert.throws(() => selectPublicStations([{ ...row, latitude: null }], [bc]),
    /Incomplete public station metadata/);
  assert.throws(() => selectPublicStations([{ ...row, longitude: null }], [bc]),
    /Incomplete public station metadata/);
});

test("contradictory identities and an empty eligible population fail closed", () => {
  const row = station(1, "UKA00001");
  const bc = series(11, 1, row.station_ref, "bc");
  assert.throws(() => selectPublicStations([row], []), /No eligible public Black Carbon stations/);
  assert.throws(() => selectPublicStations([row], [{ ...bc, timeseries_ref: "UKA99999:bc" }]),
    /Contradictory Black Carbon timeseries identity/);
  assert.throws(() => selectPublicStations([row], [bc, bc]),
    /Contradictory Black Carbon timeseries identity/);
});
