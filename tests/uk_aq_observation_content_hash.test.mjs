import assert from "node:assert/strict";
import test from "node:test";
import {
  OBSERVATION_CONTENT_HASH_COLUMNS,
  computeObservationContentHash,
  float64BigEndianHex,
  normalizeUkAirVerificationStatus,
  normalizeCanonicalObservationRow,
  preservePersistedRatifiedStatus,
  resolveLegacyVerificationStatus,
  selectObservationVerificationStatusColumn,
} from "../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  OBSERVATION_HISTORY_COLUMNS_V3,
} from "../workers/shared/uk_aq_observation_history_schema.mjs";
import { serializeCanonicalObservationV2Parquet } from "../workers/shared/uk_aq_r2_history_canonical.mjs";
import { parquetMetadataAsync, parquetSchema } from "../scripts/backup_r2/lib/uk_aq_parquet_dependencies.mjs";

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
  assert.deepEqual(OBSERVATION_HISTORY_COLUMNS_V3, [
    "connector_id", "station_id", "timeseries_id", "pollutant_code",
    "observed_at_utc", "value", "verification_status",
  ]);
  assert.deepEqual(OBSERVATION_CONTENT_HASH_COLUMNS, OBSERVATION_HISTORY_COLUMNS_V3);
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
  assert.equal(normalizeUkAirVerificationStatus(" "), "P");
  assert.equal(normalizeUkAirVerificationStatus(null), "P");
  assert.throws(() => resolveLegacyVerificationStatus(
    { verification_status: "R", vstatus: "P" }, { isSos: true },
  ), /competing.*status/i);
  assert.equal(resolveLegacyVerificationStatus({ vstatus: "P" }), "P");
  assert.equal(resolveLegacyVerificationStatus({ vstatus: "R" }), "R");
  assert.throws(() => resolveLegacyVerificationStatus(
    { vstatus: "R", status: "Provisional" },
  ), /competing.*status/i);
  assert.throws(() => resolveLegacyVerificationStatus(
    { verification_status: null, vstatus: "R" },
  ), /competing.*status/i);
  assert.throws(() => selectObservationVerificationStatusColumn(
    new Set(["verification_status", "vstatus"]),
  ), /competing.*status/i);
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
  assert.equal(resolveLegacyVerificationStatus({}), null);
  assert.equal(resolveLegacyVerificationStatus(null), null);
  assert.equal(
    normalizeUkAirVerificationStatus("verified"),
    "P",
    "only explicit ratified evidence may establish R",
  );
});


test("persisted ratified precedence changes status only for equivalent replacements", () => {
  const existing = {
    connector_id: 1, station_id: 10, timeseries_id: 101, pollutant_code: "no2",
    observed_at_utc: "2026-07-24T01:00:00.000Z", value: 12.5, vstatus: "R",
  };
  const replacement = {
    connector_id: 1, station_id: 10, timeseries_id: 101, pollutant_code: "no2",
    observed_at_utc: "2026-07-24T01:00:00.000Z", value: 12.5, verification_status: "P",
  };
  assert.equal(
    preservePersistedRatifiedStatus([replacement], [existing])[0].verification_status,
    "R",
  );

  const corrected = { ...replacement, value: 13.5 };
  assert.deepEqual(
    preservePersistedRatifiedStatus([corrected], [existing]),
    [corrected],
    "a changed source value remains authoritative",
  );
  assert.deepEqual(
    preservePersistedRatifiedStatus([], [existing]),
    [],
    "an omitted source observation is not restored",
  );
});

test("canonical logical rows reject physical compatibility fields", () => {
  assert.throws(() => normalizeCanonicalObservationRow({
    ...baseRows[0], vstatus: "R",
  }), /competing.*status/i);
  assert.throws(() => normalizeCanonicalObservationRow({
    ...baseRows[0], status: "R",
  }), /competing.*status/i);
  assert.throws(() => normalizeCanonicalObservationRow({
    ...baseRows[0], verification_status: undefined, vstatus: "R",
  }), /competing.*status/i);
});

test("shared observation serializer emits the canonical physical schema", async () => {
  const body = serializeCanonicalObservationV2Parquet([baseRows[0]]);
  const metadata = await parquetMetadataAsync(body.buffer.slice(
    body.byteOffset, body.byteOffset + body.byteLength,
  ));
  assert.deepEqual(parquetSchema(metadata).children.map((column) =>
    String(column.element.name)
  ), OBSERVATION_HISTORY_COLUMNS_V3);
  assert.throws(() => serializeCanonicalObservationV2Parquet([{
    ...baseRows[0], vstatus: "R",
  }]), /competing.*status/i);
});
