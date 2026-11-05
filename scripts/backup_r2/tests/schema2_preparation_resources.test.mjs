import "../../../tests/jsongen_test_environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildObservationHistoryV3SteadyStatePartition } from "../../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { SCHEMA2_PREPARATION_LIMITS as limits, preflightPhysicalBody,
  assertPreparationResourceTotals, assertBoundedPreparationJson } from "../lib/schema2_preparation_resources.mjs";

const physical = () => Buffer.from(buildObservationHistoryV3SteadyStatePartition({
  source: "integrity", targetWriterGitSha: "a".repeat(40), backedUpAtUtc: null,
  rows: [{ connector_id: 1, station_id: 1, timeseries_id: 1, pollutant_code: "no2",
    observed_at_utc: "2026-10-10T01:00:00.000Z", value: 10, verification_status: "P" }],
}).file_intents[0].body);

test("preparation resource boundary bounds supported actual pages and rejects aggregate overflow", () => {
  const result = preflightPhysicalBody(physical(), { row_count: 1 });
  assert.equal(result.row_count, 1);
  assert.equal(result.row_group_count, 1);
  assert.equal(result.max_variable_value_bytes, 3);
  assert.throws(() => assertPreparationResourceTotals({ decoded_rows: limits.max_decoded_rows + 1 }), /decoded_rows/);
  assert.throws(() => assertPreparationResourceTotals({ objects: limits.max_objects + 1 }), /objects/);
  assert.throws(() => assertPreparationResourceTotals({ total_body_bytes: limits.max_total_body_bytes + 1 }), /total_body_bytes/);
});

test("preparation rejects oversized Thrift allocation and ZSTD window before general decoder", () => {
  // FileMetaData.field_2 is a list. Its hostile encoded count must be rejected
  // before a general-purpose Thrift parser can allocate that list.
  const footer = Buffer.from([0x29, 0xfc, 0xff, 0xff, 0xff, 0xff, 0x07, 0]);
  const body = Buffer.concat([Buffer.from("PAR1"), footer, Buffer.alloc(4), Buffer.from("PAR1")]);
  body.writeUInt32LE(footer.length, body.length - 8);
  assert.throws(() => preflightPhysicalBody(body), /Thrift list length/);
  const file = physical(), magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offset = file.indexOf(magic);
  assert.ok(offset > 0);
  file[offset + 5] = 0xff;
  assert.throws(() => preflightPhysicalBody(file), /ZSTD window/);
});

test("preparation JSON preflight bounds depth and string allocation before parsing", () => {
  assertBoundedPreparationJson(Buffer.from(JSON.stringify({ rows: ["escaped \\\" quote", 42, null] })));
  assert.throws(() => assertBoundedPreparationJson(Buffer.from("[".repeat(limits.max_json_depth + 1) + "]".repeat(limits.max_json_depth + 1))), /nesting/);
  assert.throws(() => assertBoundedPreparationJson(Buffer.from(`"${"x".repeat(limits.max_json_string_bytes + 1)}"`)), /string/);
});
