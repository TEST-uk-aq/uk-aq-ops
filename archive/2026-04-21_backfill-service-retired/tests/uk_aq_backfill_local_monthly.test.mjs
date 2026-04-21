import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = "/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq Operations/CIC-test-uk-aq-ops";

function writeExecutable(filePath, body) {
  fs.writeFileSync(filePath, body, { mode: 0o755 });
}

test("local monthly wrapper clamps month windows and rebuilds the R2 history index for r2_history_obs_to_aqilevels", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-backfill-monthly-"));
  const fakeBin = path.join(tempRoot, "bin");
  const logDir = path.join(tempRoot, "logs");
  const denoCapture = path.join(tempRoot, "deno_calls.log");
  const nodeCapture = path.join(tempRoot, "node_calls.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  writeExecutable(
    path.join(fakeBin, "deno"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s,%s,%s\\n' "\${UK_AQ_BACKFILL_FROM_DAY_UTC:-}" "\${UK_AQ_BACKFILL_TO_DAY_UTC:-}" "\${UK_AQ_BACKFILL_RUN_MODE:-}" >> "${denoCapture}"
printf '{"ok":true}\\n'
`,
  );
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${nodeCapture}"
printf '{"ok":true}\\n'
`,
  );

  execFileSync("bash", ["scripts/uk_aq_backfill_local_monthly.sh"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      UK_AQ_BACKFILL_TRIGGER_MODE: "manual",
      UK_AQ_BACKFILL_RUN_MODE: "r2_history_obs_to_aqilevels",
      UK_AQ_BACKFILL_DRY_RUN: "false",
      UK_AQ_BACKFILL_FORCE_REPLACE: "true",
      UK_AQ_BACKFILL_FROM_DAY_UTC: "2025-01-01",
      UK_AQ_BACKFILL_TO_DAY_UTC: "2025-02-10",
      UK_AQ_BACKFILL_MONTHLY_LOG_DIR: logDir,
    },
    stdio: "pipe",
  });

  const denoCalls = fs.readFileSync(denoCapture, "utf8").trim().split("\n");
  assert.deepEqual(denoCalls, [
    "2025-01-01,2025-01-31,r2_history_obs_to_aqilevels",
    "2025-02-01,2025-02-10,r2_history_obs_to_aqilevels",
  ]);

  const nodeCalls = fs.readFileSync(nodeCapture, "utf8").trim().split("\n");
  assert.equal(nodeCalls.length, 1);
  assert.match(nodeCalls[0], /scripts\/backup_r2\/uk_aq_build_r2_history_index\.mjs/);
});
