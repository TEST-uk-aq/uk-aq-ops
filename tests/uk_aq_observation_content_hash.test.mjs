import assert from "node:assert/strict";
import test from "node:test";
import {
  computeObservationContentHash,
  float64BigEndianHex,
  normalizeUkAirVerificationStatus,
  resolveLegacyVerificationStatus,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";

const baseRows = [
  {
    connector_id: 1,
    station_id: 10,
    timeseries_id: 101,
    pollutant_code: "no2",
    observed_at_utc: "2026-07-24T01:00:00.000Z",
    value: -1.25,
    verification_status: "P",
  },
  {
    connector_id: 1,
    station_id: 10,
    timeseries_id: 101,
    pollutant_code: "no2",
    observed_at_utc: "2026-07-24T02:00:00.000Z",
    value: -0,
    verification_status: null,
  },
];

test("observation content hash v1 is deterministic and status-aware", () => {
  const expected = computeObservationContentHash(baseRows);
  assert.equal(
    computeObservationContentHash([...baseRows].reverse())
      .observation_content_hash,
    expected.observation_content_hash,
  );
  assert.deepEqual(expected.verification_status_counts, {
    P: 1,
    R: 0,
    null: 1,
  });
  assert.equal(
    Object.values(expected.verification_status_counts)
      .reduce((sum, value) => sum + value, 0),
    expected.observation_content_hash_row_count,
  );
  assert.equal(float64BigEndianHex(-0), float64BigEndianHex(0));
  assert.equal(float64BigEndianHex(-1.25), "bff4000000000000");

  for (const [field, value] of [
    ["connector_id", 2],
    ["station_id", 11],
    ["timeseries_id", 102],
    ["pollutant_code", "o3"],
    ["observed_at_utc", "2026-07-24T03:00:00.000Z"],
    ["value", -1.5],
    ["verification_status", "R"],
  ]) {
    const changed = baseRows.map((row, index) =>
      index === 0 ? { ...row, [field]: value } : row
    );
    assert.notEqual(
      computeObservationContentHash(changed).observation_content_hash,
      expected.observation_content_hash,
      field,
    );
  }

  const withDuplicate = computeObservationContentHash([
    ...baseRows,
    baseRows[0],
  ]);
  assert.notEqual(
    withDuplicate.observation_content_hash,
    expected.observation_content_hash,
  );
  assert.equal(withDuplicate.observation_content_hash_row_count, 3);

  assert.equal(normalizeUkAirVerificationStatus(" P "), "P");
  assert.equal(normalizeUkAirVerificationStatus("provisional"), "P");
  assert.equal(normalizeUkAirVerificationStatus("R"), "R");
  assert.equal(normalizeUkAirVerificationStatus(" ratified "), "R");
  assert.equal(normalizeUkAirVerificationStatus(" "), null);
  assert.equal(normalizeUkAirVerificationStatus(null), null);
  assert.equal(
    resolveLegacyVerificationStatus(
      { verification_status: "R", status: "Provisional" },
      { isSos: true },
    ),
    "R",
  );
  assert.equal(
    resolveLegacyVerificationStatus(
      { status: "Provisional" },
      { isSos: true },
    ),
    "P",
  );
  assert.equal(
    resolveLegacyVerificationStatus(
      { status: "connector-specific" },
      { isSos: false },
    ),
    null,
  );
  assert.throws(
    () => normalizeUkAirVerificationStatus("verified"),
    /Unsupported UK-AIR verification status/,
  );
});
