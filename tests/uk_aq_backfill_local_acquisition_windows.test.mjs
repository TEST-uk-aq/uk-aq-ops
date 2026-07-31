import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(repoRoot, "scripts", "uk_aq_backfill_local.sh");

function runWrapper(tempRoot, acquisitionMode) {
  const invocationLog = join(
    tempRoot,
    acquisitionMode === "acquire" ? "acquire.log" : "ordinary.log",
  );
  const fakeDeno = join(tempRoot, "fake-deno.sh");
  writeFileSync(fakeDeno, `#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s|objects_written_r2=0\\n' \
  "\${UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE:-}" \
  "\${UK_AQ_BACKFILL_FROM_DAY_UTC}" \
  "\${UK_AQ_BACKFILL_TO_DAY_UTC}" \
  >> "\${UK_AQ_BACKFILL_TEST_INVOCATION_LOG}"
printf '{"status":"ok","objects_written_r2":0}\\n'
`);
  chmodSync(fakeDeno, 0o755);

  const env = {
    ...process.env,
    UK_AQ_ENV_NAME: "local-test",
    UK_AQ_BACKFILL_RUN_MODE: "source_to_r2",
    UK_AQ_BACKFILL_DRY_RUN: "false",
    UK_AQ_BACKFILL_FORCE_REPLACE: "false",
    UK_AQ_BACKFILL_OUTPUT_SCOPE: "observations_only",
    UK_AQ_BACKFILL_FROM_DAY_UTC: "2026-06-30",
    UK_AQ_BACKFILL_TO_DAY_UTC: "2026-07-02",
    UK_AQ_BACKFILL_CONNECTOR_IDS: "1",
    UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS: "no2,pm25",
    UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX: "false",
    UK_AQ_BACKFILL_LOCAL_LOG_DIR: join(tempRoot, "logs"),
    UK_AQ_BACKFILL_DENO_BIN: fakeDeno,
    UK_AQ_BACKFILL_NODE_BIN: process.execPath,
    UK_AQ_BACKFILL_TEST_INVOCATION_LOG: invocationLog,
  };
  if (acquisitionMode) {
    env.UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE = acquisitionMode;
  } else {
    delete env.UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE;
  }

  const result = spawnSync("bash", [wrapper], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"objects_written_r2":0/);
  return {
    invocations: readFileSync(invocationLog, "utf8").trim().split("\n"),
    stdout: result.stdout,
  };
}

test("SOS acquisition bypasses month splitting while ordinary backfill retains it", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "uk-aq-backfill-windows-"));
  try {
    const acquisition = runWrapper(tempRoot, "acquire");
    assert.deepEqual(acquisition.invocations, [
      "acquire|2026-06-30|2026-07-02|objects_written_r2=0",
    ]);
    assert.match(acquisition.stdout, /Windows attempted: 1/);

    const ordinary = runWrapper(tempRoot, "");
    assert.deepEqual(ordinary.invocations, [
      "|2026-06-30|2026-06-30|objects_written_r2=0",
      "|2026-07-01|2026-07-02|objects_written_r2=0",
    ]);
    assert.match(ordinary.stdout, /Windows attempted: 2/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
