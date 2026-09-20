import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import { parquetMetadataAsync, parquetSchema } from "hyparquet";

import { computeObservationContentHash } from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import { OBSERVATION_HISTORY_COLUMNS_V3 } from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import { buildObservationHistoryV3SteadyStatePartition, OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES } from "../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import { assertApplyArguments, classifyMigrationPhysicalColumns, decodeParquet, parseArgs, requireTestGuard, sealMigrationPlan } from "./uk_aq_migrate_observation_vstatus_to_verification_status.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = {
  connector_id: 1, station_id: 2, timeseries_id: 3, pollutant_code: "no2",
  observed_at_utc: "2026-09-19T01:00:00.000Z", value: 12.5,
};

function physicalFixture(statusName, statuses) {
  const columns = {
    connector_id: arrow.vectorFromArray(statuses.map(() => 1), new arrow.Int32()),
    station_id: arrow.vectorFromArray(statuses.map(() => 2), new arrow.Int32()),
    timeseries_id: arrow.vectorFromArray(statuses.map(() => 3), new arrow.Int32()),
    pollutant_code: arrow.vectorFromArray(statuses.map(() => "no2"), new arrow.Utf8()),
    observed_at_utc: arrow.vectorFromArray(statuses.map((_, index) => new Date(Date.parse(base.observed_at_utc) + index * 3600000)), new arrow.TimestampMillisecond()),
    value: arrow.vectorFromArray(statuses.map(() => 12.5), new arrow.Float64()),
    [statusName]: arrow.vectorFromArray(statuses, new arrow.Utf8()),
  };
  const table = parquetWasm.Table.fromIPCStream(arrow.tableToIPC(arrow.tableFromArrays(columns), "stream"));
  return Buffer.from(parquetWasm.writeParquet(table, new parquetWasm.WriterPropertiesBuilder().build()));
}

test("migration-local decoder preserves P, R and null and canonical content hash", async () => {
  // The current writer initialises the same local parquet-wasm runtime used by the fixture.
  buildObservationHistoryV3SteadyStatePartition({ source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
    rows: [{ ...base, verification_status: "R" }], targetWriterGitSha: "a".repeat(40) });
  const body = physicalFixture("vstatus", ["P", "R", null]);
  const physical = await decodeParquet(body, "erroneous");
  assert.equal(classifyMigrationPhysicalColumns(physical.columns), "erroneous");
  assert.deepEqual(physical.rows.map((row) => row.verification_status), ["P", "R", null]);
  assert.deepEqual(physical.rows.map(Object.keys), physical.rows.map(() => OBSERVATION_HISTORY_COLUMNS_V3));
  const canonical = physical.rows.map((row) => ({ ...row }));
  assert.equal(computeObservationContentHash(physical.rows).observation_content_hash,
    computeObservationContentHash(canonical).observation_content_hash);
  const target = buildObservationHistoryV3SteadyStatePartition({ source: OBSERVATION_HISTORY_V3_STEADY_STATE_SOURCES.integrity,
    rows: canonical, targetWriterGitSha: "a".repeat(40) });
  const written = target.file_intents[0].body;
  const metadata = await parquetMetadataAsync(written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength));
  assert.deepEqual(parquetSchema(metadata).children.map((column) => String(column.element.name)), OBSERVATION_HISTORY_COLUMNS_V3);
  const decodedTarget = await decodeParquet(written, "canonical");
  assert.deepEqual(decodedTarget.rows.map((row) => row.verification_status), ["P", "R", null]);
  assert.equal(computeObservationContentHash(decodedTarget.rows).observation_content_hash,
    computeObservationContentHash(physical.rows).observation_content_hash);
});

test("manifest/footer mismatch and competing physical status fields fail closed", async () => {
  const body = physicalFixture("vstatus", ["R"]);
  await assert.rejects(() => decodeParquet(body, "canonical"), /schema mismatch/i);
  assert.throws(() => classifyMigrationPhysicalColumns([...OBSERVATION_HISTORY_COLUMNS_V3, "vstatus"]), /unsupported/i);
  assert.throws(() => classifyMigrationPhysicalColumns([...OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6), "unexpected_status"]), /unsupported/i);
  assert.throws(() => classifyMigrationPhysicalColumns([...OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6), "vstatus", "status"]), /unsupported/i);
  assert.throws(() => classifyMigrationPhysicalColumns([...OBSERVATION_HISTORY_COLUMNS_V3.slice(0, 6), "status", "verification_status"]), /unsupported/i);
});

test("plan sealing is deterministic and APPLY requires explicit pinned identity", () => {
  const core = { plan_schema_version: 1, purpose: "physical-vstatus-to-verification_status", affected_scopes: [{ day_utc: "2026-09-19" }] };
  assert.deepEqual(sealMigrationPlan(core), sealMigrationPlan(structuredClone(core)));
  assert.match(sealMigrationPlan(core).plan_sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => assertApplyArguments({ mode: "apply", apply: false, planPath: "plan.json", expectedPlanSha256: "a".repeat(64) }), /requires/i);
  assert.throws(() => assertApplyArguments({ mode: "apply", apply: true, planPath: "plan.json" }), /requires/i);
  assert.throws(() => parseArgs(["--mode", "apply", "--plan-path", "plan.json", "--expected-test-bucket", "uk-aq-history-cic-test",
    "--target-writer-git-sha", "a".repeat(40), "--dropbox-root", "/tmp/backup"]), /requires/i);
  assert.throws(() => requireTestGuard({ expectedTestBucket: "uk-aq-history-cic-test" }, { UK_AQ_ENV_NAME: "LIVE" }), /TEST/i);
});

test("ordinary active source contains no migration-only physical name", () => {
  const paths = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).split("\n");
  const violations = paths.filter((relative) => relative && /\.(?:mjs|js|ts|py)$/.test(relative) &&
    !relative.startsWith("archive/") && !relative.startsWith("scripts/maintenance/uk_aq_migrate_observation_vstatus_to_verification_status"))
    .filter((relative) => fs.readFileSync(path.join(repo, relative), "utf8").includes("vstatus"));
  assert.deepEqual(violations, []);
});
