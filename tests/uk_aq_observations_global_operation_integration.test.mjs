import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkIntegrityDropboxCurrentness,
} from "../scripts/backup_r2/uk_aq_check_integrity_dropbox_currentness.mjs";
import {
  runChildWhileLockHeld,
} from "../scripts/operations/uk_aq_with_observations_global_operation_lock.mjs";
import {
  parseLockedHistoryBackupArgs,
  requireLockedHistoryBackupMutation,
  runLockedHistoryBackup,
} from "../scripts/backup_r2/uk_aq_run_locked_history_backup.mjs";
import {
  requireIntegrityApplyGlobalLock,
} from "../scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs";
import {
  runObservationHistoryMigrationV3,
} from "../scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs";
import {
  ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3,
} from "../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs";
import {
  emptyHierarchicalStateRoot,
} from "../scripts/backup_r2/lib/hierarchical_backup_v2.mjs";
import {
  buildR2HistoryV2ObservationsRootManifest,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV,
  observationsGlobalOperationLockIdentity,
} from "../workers/shared/uk_aq_r2_history_writer.mjs";

const h = (char) => char.repeat(64);

function lockEnv(owner, runId) {
  const identity = observationsGlobalOperationLockIdentity();
  return {
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.held]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner]: owner,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.runId]: runId,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.logicalIdentity]: identity.logical_identity,
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.classId]: String(identity.class_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.objectId]: String(identity.object_id),
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.nonce]: "test-nonce",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.acquired]: "true",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.waitMs]: "0",
    [OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.outcome]: "held",
  };
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for lifecycle condition");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function startLifecycleFixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-lock-lifecycle-"));
  const statePath = path.join(temporaryRoot, "state.json");
  const heartbeatPath = path.join(temporaryRoot, "heartbeat");
  const fixturePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/observations_global_operation_lifecycle_fixture.mjs",
  );
  const coordinator = spawn(process.execPath, [fixturePath, statePath, heartbeatPath], {
    stdio: "ignore",
  });
  let state = null;
  t.after(() => {
    if (processIsAlive(coordinator.pid)) coordinator.kill("SIGKILL");
    if (state?.process_group_id) {
      try {
        process.kill(-state.process_group_id, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(statePath) && fs.existsSync(heartbeatPath));
  state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  await waitFor(() => fs.statSync(heartbeatPath).size >= 2);
  return { coordinator, heartbeatPath, state };
}

function completeCheckpoint(rootHash) {
  const state = emptyHierarchicalStateRoot();
  state.observations = {
    processed_source_root_hash: rootHash,
    years: [{
      year: "2026",
      processed_source_year_hash: h("b"),
      months: [{
        month: "08",
        state_shard_key: "_ops/checkpoints/r2_history_backup_state_v2/observations/year=2026/month=08.json",
        processed_source_month_hash: h("c"),
        state_shard_hash: h("d"),
      }],
    }],
  };
  state.global_units.observation_run_manifests = {
    state_shard_key: "_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json",
    processed_source_hash: h("e"),
    state_shard_hash: h("f"),
  };
  state.global_units.observations_timeseries_latest = {
    source_relative_path: "history/_index_v2/observations_timeseries_latest.json",
    processed_source_sha256: h("a"),
    byte_size: 123,
    copied_at: "2026-08-24T00:00:00.000Z",
    verified: true,
  };
  state.core = {
    state_shard_key: "_ops/checkpoints/r2_history_backup_state_v2/global/core.json",
    processed_source_hash: h("1"),
    state_shard_hash: h("3"),
  };
  state.timeseries_binding = {
    processed_source_root_hash: h("2"),
    ranges: [],
  };
  return state;
}

test("Integrity currentness gate runs under the global lock and blocks a stale checkpoint", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-currentness-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const stateDirectory = path.join(
    temporaryRoot,
    "_ops/checkpoints/r2_history_backup_state_v2",
  );
  fs.mkdirSync(stateDirectory, { recursive: true });
  const liveRoot = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: "history/v2/observations",
    yearManifests: [{
      year: "2026",
      manifest_key: "history/v2/observations/_manifests/year=2026/manifest.json",
      content_hash: h("b"),
    }],
  });
  const checkpointPath = path.join(stateDirectory, "root.json");
  fs.writeFileSync(checkpointPath, JSON.stringify(completeCheckpoint(liveRoot.content_hash)));
  const getLiveRoot = async () => ({ body: Buffer.from(JSON.stringify(liveRoot)), bytes: 456 });
  const current = await checkIntegrityDropboxCurrentness({
    dropboxRoot: temporaryRoot,
    getLiveRoot,
    lockContext: { valid: true, owner: "integrity", run_id: "integrity:test" },
  });
  assert.equal(current.allowed, true);
  assert.equal(current.checkpoint_live_root_match, true);
  assert.equal(
    current.checkpoint.observations_processed_source_root_hash,
    current.live_observations_root.content_hash,
  );

  fs.writeFileSync(checkpointPath, JSON.stringify(completeCheckpoint(h("9"))));
  await assert.rejects(
    checkIntegrityDropboxCurrentness({
      dropboxRoot: temporaryRoot,
      getLiveRoot,
      lockContext: { valid: true, owner: "integrity", run_id: "integrity:test" },
    }),
    (error) => error.code === "UK_AQ_INTEGRITY_DROPBOX_CHECKPOINT_STALE"
      && error.result.checkpoint_live_root_match === false,
  );
});

test("backup child holds the coordinator context across inventory then sync", () => {
  const args = parseLockedHistoryBackupArgs([
    "--source-root", "r2:bucket",
    "--dest-root", "dropbox:backup",
    "--observations-prefix", "history/v2/observations",
    "--runs-prefix", "history/v2/_ops/observations/runs",
    "--core-prefix", "history/v2/core",
    "--timeseries-binding-prefix", "history/_index_v2/timeseries_binding",
    "--history-index-version", "v2",
    "--inventory-root-prefix", "history/_index_v2/backup_inventory_v2",
    "--state-root-prefix", "_ops/checkpoints/r2_history_backup_state_v2",
    "--inventory-report-out", "tmp/inventory.json",
    "--backup-report-out", "tmp/backup.json",
  ]);
  const calls = [];
  const env = lockEnv("r2_history_dropbox_backup", "backup:test");
  const result = runLockedHistoryBackup({
    args,
    env,
    run: (command, commandArgs, options) => {
      calls.push({ command, commandArgs, env: options.env });
      return { status: 0, signal: null, error: null };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].commandArgs[0], /build_backup_inventory\.mjs$/);
  assert.match(calls[1].commandArgs[0], /sync_history_to_dropbox\.mjs$/);
  assert.equal(calls[0].env, env);
  assert.equal(calls[1].env, env);
});

test("backup mutation CLIs fail closed without the coordinator while dry-run remains unlocked", () => {
  assert.equal(requireLockedHistoryBackupMutation({ dryRun: true, env: {} }), null);
  assert.throws(
    () => requireLockedHistoryBackupMutation({ dryRun: false, env: {} }),
    /valid coordinator-owned observations global operation lock context/,
  );
  assert.equal(
    requireLockedHistoryBackupMutation({
      dryRun: false,
      env: lockEnv("r2_history_dropbox_backup", "backup:test"),
    }).valid,
    true,
  );

  const env = { ...process.env };
  for (const key of Object.values(OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV)) delete env[key];
  for (const [script, args] of [
    [
      "scripts/backup_r2/build_backup_inventory.mjs",
      ["--source-root", "unused:test", "--history-index-version", "v2"],
    ],
    [
      "scripts/backup_r2/sync_history_to_dropbox.mjs",
      ["--source-root", "unused:test", "--dest-root", "unused:dropbox"],
    ],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /valid coordinator-owned observations global operation lock context/,
    );
    assert.doesNotMatch(result.stderr, /rclone/i);
  }
});

test("lost retained lock terminates the entire owned child operation fail-closed", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.stdio = [null, null, null, new PassThrough()];
  const signals = [];
  const controller = new AbortController();
  const operation = runChildWhileLockHeld({
    command: "ignored",
    env: {},
    lockSignal: controller.signal,
    spawnProcess: () => child,
    terminate: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
        });
      }
    },
  });
  const lost = Object.assign(new Error("retained session lost"), {
    code: "UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_LOST",
  });
  controller.abort(lost);
  await assert.rejects(operation, (error) => error === lost);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("supervised locked command preserves normal successful completion", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-lock-success-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const resultPath = path.join(temporaryRoot, "result.txt");
  const code = await runChildWhileLockHeld({
    command: process.execPath,
    commandArgs: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'ok')",
      resultPath,
    ],
    env: process.env,
  });
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(resultPath, "utf8"), "ok");
});

test("unexpected coordinator SIGKILL cannot leave the protected child running", async (t) => {
  const { coordinator, heartbeatPath, state } = await startLifecycleFixture(t);
  const coordinatorExit = once(coordinator, "exit");
  coordinator.kill("SIGKILL");
  const [, signal] = await coordinatorExit;
  assert.equal(signal, "SIGKILL");
  await waitFor(() => !processIsAlive(state.pid));
  const stoppedSize = fs.statSync(heartbeatPath).size;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.statSync(heartbeatPath).size, stoppedSize);
});

test("controlled coordinator SIGTERM terminates the protected group cleanly", async (t) => {
  const { coordinator, heartbeatPath, state } = await startLifecycleFixture(t);
  const coordinatorExit = once(coordinator, "exit");
  coordinator.kill("SIGTERM");
  const [code, signal] = await coordinatorExit;
  assert.equal(signal, null);
  assert.equal(code, 143);
  await waitFor(() => !processIsAlive(state.pid));
  const stoppedSize = fs.statSync(heartbeatPath).size;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.statSync(heartbeatPath).size, stoppedSize);
});

test("Integrity apply child verifies coordinator run ownership", (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-apply-lock-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const runStatePath = path.join(temporaryRoot, "run-state.json");
  fs.writeFileSync(runStatePath, JSON.stringify({
    observations_global_operation_lock: { run_id: "integrity:test" },
  }));
  assert.equal(
    requireIntegrityApplyGlobalLock({
      runStatePath,
      env: lockEnv("integrity", "integrity:test"),
    }).run_id,
    "integrity:test",
  );
  assert.throws(
    () => requireIntegrityApplyGlobalLock({
      runStatePath,
      env: lockEnv("integrity", "integrity:other"),
    }),
    /valid coordinator-owned observations global operation lock context/,
  );
});

test("v3 migrate --apply acquires the global lock before reading migration authority", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-migrate-lock-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const limitsPath = path.join(temporaryRoot, "limits.json");
  fs.writeFileSync(limitsPath, JSON.stringify(ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3));
  const argv = [
    "--mode", "migrate",
    "--apply",
    "--writers-frozen",
    "--environment", "TEST",
    "--expected-bucket", "test-bucket",
    "--migration-run-id", "migration:test",
    "--target-writer-git-sha", "0123456789abcdef",
    "--writer-limits-json", limitsPath,
    "--dropbox-root", path.join(temporaryRoot, "missing-dropbox-authority"),
    "--expected-inventory-root-sha256", h("a"),
    "--expected-state-root-sha256", h("b"),
    "--expected-plan-sha256", h("c"),
    "--report-out", path.join(temporaryRoot, "report.json"),
    "--checkpoint-out", path.join(temporaryRoot, "checkpoint.json"),
  ];
  let lockedOptions = null;
  const result = await runObservationHistoryMigrationV3({
    argv,
    env: {
      SUPABASE_DB_URL: "postgresql://direct-session",
      CFLARE_R2_ENDPOINT: "https://example.invalid",
      CFLARE_R2_BUCKET: "test-bucket",
      CFLARE_R2_REGION: "auto",
      CFLARE_R2_ACCESS_KEY_ID: "test-access",
      CFLARE_R2_SECRET_ACCESS_KEY: "test-secret",
      UK_AQ_ENV_NAME: "TEST",
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_INDEX_VERSION: "v2",
      UK_AQ_R2_HISTORY_INTEGRITY_VERSION: "v2",
    },
    runLockedCommand: async (options) => {
      lockedOptions = options;
      return 0;
    },
  });
  assert.deepEqual(result, { delegated: true, exitCode: 0 });
  assert.equal(lockedOptions.owner, "observation_history_migration_v3");
  assert.equal(lockedOptions.runId, "migration:test");
  assert.equal(lockedOptions.databaseUrl, "postgresql://direct-session");
  assert.deepEqual(lockedOptions.commandArgs.slice(1), argv);
});

test("v2 rollback --apply delegates the complete command to the same global lock", async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uk-aq-rollback-lock-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const limitsPath = path.join(temporaryRoot, "limits.json");
  fs.writeFileSync(limitsPath, JSON.stringify(ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3));
  const argv = [
    "--mode", "rollback",
    "--apply",
    "--writers-frozen",
    "--environment", "TEST",
    "--expected-bucket", "test-bucket",
    "--migration-run-id", "migration:test",
    "--target-writer-git-sha", "0123456789abcdef",
    "--writer-limits-json", limitsPath,
    "--dropbox-root", path.join(temporaryRoot, "missing-dropbox-authority"),
    "--expected-inventory-root-sha256", h("a"),
    "--expected-state-root-sha256", h("b"),
    "--expected-plan-sha256", h("c"),
    "--report-out", path.join(temporaryRoot, "report.json"),
    "--checkpoint-in", path.join(temporaryRoot, "missing-checkpoint.json"),
  ];
  let lockedOptions = null;
  const result = await runObservationHistoryMigrationV3({
    argv,
    env: {
      SUPABASE_DB_URL: "postgresql://direct-session",
      CFLARE_R2_ENDPOINT: "https://example.invalid",
      CFLARE_R2_BUCKET: "test-bucket",
      CFLARE_R2_REGION: "auto",
      CFLARE_R2_ACCESS_KEY_ID: "test-access",
      CFLARE_R2_SECRET_ACCESS_KEY: "test-secret",
      UK_AQ_ENV_NAME: "TEST",
      UK_AQ_R2_HISTORY_VERSION: "v2",
      UK_AQ_R2_HISTORY_INDEX_VERSION: "v2",
      UK_AQ_R2_HISTORY_INTEGRITY_VERSION: "v2",
    },
    runLockedCommand: async (options) => {
      lockedOptions = options;
      return 75;
    },
  });
  assert.deepEqual(result, { delegated: true, exitCode: 75 });
  assert.equal(lockedOptions.owner, "observation_history_rollback_v2");
  assert.equal(lockedOptions.runId, "migration:test");
  assert.equal(lockedOptions.databaseUrl, "postgresql://direct-session");
  const cliIndex = lockedOptions.commandArgs.findIndex((value) =>
    String(value).endsWith("/uk_aq_observation_history_migration_v3.mjs")
  );
  assert.notEqual(cliIndex, -1);
  assert.deepEqual(lockedOptions.commandArgs.slice(cliIndex + 1), argv);
});
