import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  validateConfig,
} from "../scripts/AQI-levels-refactor-June-2026/local_aqilevels_rebuild_from_dropbox.mjs";

const scriptPath = path.resolve(
  "scripts/AQI-levels-refactor-June-2026/local_aqilevels_rebuild_from_dropbox.mjs",
);

async function tempSourceRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "uk-aq-local-aqi-source-"));
  await fsp.mkdir(path.join(root, "history/v1/observations"), { recursive: true });
  return root;
}

test("local runner refuses a Dropbox work directory", async () => {
  const sourceRoot = await tempSourceRoot();
  const config = parseArgs([
    "--from-day",
    "2025-01-01",
    "--to-day",
    "2025-01-01",
    "--source-root",
    sourceRoot,
    "--work-root",
    "/tmp/Dropbox/aqi-work",
  ], {});

  assert.throws(() => validateConfig(config), /Dropbox work directory/);
});

test("local runner refuses to write generated AQI inside source backup", async () => {
  const sourceRoot = await tempSourceRoot();
  const config = parseArgs([
    "--from-day",
    "2025-01-01",
    "--to-day",
    "2025-01-01",
    "--source-root",
    sourceRoot,
    "--work-root",
    path.join(sourceRoot, "_generated-aqi"),
  ], {});

  assert.throws(() => validateConfig(config), /Dropbox source backup/);
});

test("local runner default prefix is hourly AQI history", () => {
  const config = parseArgs([
    "--from-day",
    "2025-01-01",
    "--to-day",
    "2025-01-01",
  ], {});

  assert.equal(config.aqiPrefix, "history/v1/aqilevels/hourly");
});

test("local rebuild script does not call index, inventory, or Dropbox sync", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.equal(source.includes("uk_aq_build_r2_history_index.mjs"), true, "manual next-step text should be printed");
  assert.equal(source.includes("build_backup_inventory.mjs"), true, "manual next-step text should be printed");
  assert.equal(/spawnSync\([^)]*uk_aq_build_r2_history_index\.mjs/.test(source), false);
  assert.equal(/spawnSync\([^)]*build_backup_inventory\.mjs/.test(source), false);
  assert.equal(/spawnSync\([^)]*sync_history_to_dropbox\.mjs/.test(source), false);
  assert.equal(/rclone.*uk-aq-history-live/i.test(source), false);
});
