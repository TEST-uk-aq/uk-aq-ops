import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildObservationHistoryV3SteadyStatePartition,
} from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(repoRoot, "scripts", "uk_aq_backfill_local.sh");
const integrityWrapper = join(
  repoRoot,
  "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill_v3.sh",
);
const worker = join(repoRoot, "workers", "uk_aq_backfill_local", "run_job.ts");

function baseEnvironment(tempRoot, fakeDeno, invocationLog) {
  return {
    ...process.env,
    UK_AQ_ENV_NAME: "TEST",
    UK_AQ_BACKFILL_RUN_MODE: "source_to_r2",
    UK_AQ_BACKFILL_DRY_RUN: "false",
    UK_AQ_BACKFILL_FORCE_REPLACE: "true",
    UK_AQ_BACKFILL_OUTPUT_SCOPE: "observations_only",
    UK_AQ_BACKFILL_FROM_DAY_UTC: "2026-06-01",
    UK_AQ_BACKFILL_TO_DAY_UTC: "2026-06-01",
    UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX: "false",
    UK_AQ_R2_HISTORY_VERSION: "v3",
    UK_AQ_BACKFILL_LOCAL_LOG_DIR: join(tempRoot, "logs"),
    UK_AQ_BACKFILL_DENO_BIN: fakeDeno,
    UK_AQ_BACKFILL_NODE_BIN: process.execPath,
    UK_AQ_BACKFILL_TEST_INVOCATION_LOG: invocationLog,
  };
}

test("disabled full-index path does not apply its v1/v2 validation to v3", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "sos-light-v3-boundary-"));
  try {
    const invocationLog = join(tempRoot, "invoked.log");
    const fakeDeno = join(tempRoot, "fake-deno.sh");
    writeFileSync(fakeDeno, `#!/usr/bin/env bash
set -euo pipefail
printf 'invoked\\n' > "\${UK_AQ_BACKFILL_TEST_INVOCATION_LOG}"
printf '{"status":"ok","objects_written_r2":0}\\n'
`);
    chmodSync(fakeDeno, 0o755);
    const env = baseEnvironment(tempRoot, fakeDeno, invocationLog);

    const result = spawnSync("bash", [wrapper], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(invocationLog, "utf8"), "invoked\n");

    env.UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX = "true";
    rmSync(invocationLog, { force: true });
    const rejected = spawnSync("bash", [wrapper], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /Invalid UK_AQ_R2_HISTORY_VERSION for final index rebuild: v3/);
    assert.equal(existsSync(invocationLog), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("worker source keeps generic v3 unsupported and requires the narrow Integrity contract", () => {
  const source = readFileSync(worker, "utf8");
  assert.match(source, /Unsupported .*HISTORY_VERSION_ENV}=v3 invocation/);
  assert.match(source, /workerPurpose === "source_evidence_only"/);
  assert.match(source, /workerPurpose === "repair_proposal"/);
  assert.match(source, /canonicalWritesAllowed === "false"/);
  assert.match(source, /finalIndexRebuild === "false"/);
  assert.match(source, /outputScope === "observations_only"/);
  assert.match(source, /integrityInvocation/);

  const structuredExporter = source.slice(
    source.indexOf("async function exportStructuredObsConnectorRows"),
    source.indexOf("async function exportAqiConnectorRowsToR2", source.indexOf("async function exportStructuredObsConnectorRows")),
  );
  assert.match(
    source,
    /if \(HISTORY_R2_WRITE_VERSION === "v3"\) return OBS_R2_HISTORY_PREFIX_V3/,
  );
  assert.match(
    source,
    /DEFAULT_OBSERVATION_HISTORY_V3_STEADY_STATE_PREFIX/,
  );
  assert.match(
    structuredExporter,
    /const observationsPrefix = activeStructuredObsHistoryPrefix\(\)/,
  );
  assert.match(structuredExporter, /buildHistoryV2PartKey\(\s*observationsPrefix,/);
  assert.match(
    structuredExporter,
    /buildHistoryV2PollutantManifestKey\(\s*observationsPrefix,/,
  );
  assert.match(
    structuredExporter,
    /buildHistoryV2ConnectorManifestKey\(\s*observationsPrefix,/,
  );
  assert.doesNotMatch(structuredExporter, /OBS_R2_HISTORY_PREFIX_V2/);

  const bridgeSource = readFileSync(integrityWrapper, "utf8");
  assert.match(bridgeSource, /source_evidence_only\)/);
  assert.match(bridgeSource, /repair_proposal\)/);
  assert.match(
    bridgeSource,
    /UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED.*!= "false"/s,
  );
  assert.doesNotMatch(bridgeSource, /source_repair\)/);
});

test("the v3 proposal writer contract produces no v2 canonical target keys", () => {
  const prepared = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity",
    rows: [{
      connector_id: 1,
      station_id: 10,
      timeseries_id: 101,
      pollutant_code: "no2",
      observed_at_utc: "2026-06-01T00:00:00.000Z",
      value: 12.5,
      verification_status: "P",
    }],
    targetWriterGitSha: "3".repeat(40),
    backedUpAtUtc: "2026-09-15T00:00:00.000Z",
  });
  const keys = [
    ...prepared.file_intents.map((intent) => intent.key),
    prepared.canonical_pollutant_manifest.key,
  ];
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => key.startsWith("history/v3/")), keys.join("\n"));
  assert.equal(keys.filter((key) => key.startsWith("history/v2/")).length, 0);
  assert.ok(
    prepared.v3_hierarchy.scoped_manifest.key.startsWith("history/_index_v3/"),
  );
});
