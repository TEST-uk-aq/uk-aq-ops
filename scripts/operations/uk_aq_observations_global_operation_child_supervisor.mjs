#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { relayOriginalOperationAssertions } from './lib/uk_aq_prune_original_operation.mjs';
import { INTEGRITY_CHANNEL_ENV, isIntegrityCoordinator, relayIntegrityAssertions } from './lib/uk_aq_integrity_original_operation.mjs';
import { OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV } from '../../workers/shared/uk_aq_r2_history_writer.mjs';

const COORDINATOR_LIVENESS_FD = 3;
const FORCED_EXIT_DELAY_MS = 10_000;

function parseCommand(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("Locked child supervisor requires -- followed by a command");
  }
  return Object.freeze({
    command: argv[separator + 1],
    commandArgs: Object.freeze(argv.slice(separator + 2)),
  });
}

function signalProcessGroup(signal) {
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function superviseLockedCommand({
  command,
  commandArgs = [],
  env = process.env,
  livenessFd = COORDINATOR_LIVENESS_FD,
  spawnProcess = spawn,
} = {}) {
  if (process.platform === "win32") {
    throw new Error("Observations global operation child supervision requires POSIX process groups");
  }

  let finished = false;
  let stoppingSignal = null;
  let forceTimer = null;
  let child = null;
  let closeAssertions = null;
  let closeIntegrity = null;

  const emergencyStop = () => {
    try {
      signalProcessGroup("SIGKILL");
    } catch (_error) {
      child?.kill?.("SIGKILL");
      process.kill(process.pid, "SIGKILL");
    }
  };

  const liveness = fs.createReadStream(null, {
    fd: livenessFd,
    autoClose: true,
  });
  liveness.once("end", emergencyStop);
  liveness.once("close", emergencyStop);
  liveness.once("error", emergencyStop);
  liveness.resume();
  process.once("disconnect", emergencyStop);

  const reportResult = (result) => {
    if (!process.send || !process.connected) {
      signalProcessGroup("SIGKILL");
      return;
    }
    process.send({ type: "uk_aq_locked_command_result", ...result }, (error) => {
      if (error) signalProcessGroup("SIGKILL");
    });
  };

  const requestControlledStop = (signal) => {
    if (finished || stoppingSignal) return;
    stoppingSignal = signal;
    closeIntegrity?.();
    // The coordinator signals this entire process group, so the protected
    // child has already received the same controlled cancellation signal.
    forceTimer = setTimeout(() => signalProcessGroup("SIGKILL"), FORCED_EXIT_DELAY_MS);
    forceTimer.unref?.();
  };
  const onSigint = () => requestControlledStop("SIGINT");
  const onSigterm = () => requestControlledStop("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // After reporting the target result, remain alive until the coordinator
  // kills this whole process group and confirms no descendants survived.
  return await new Promise(() => {
    const prune = env[OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner] === 'prune_daily';
    const integrity = !prune && env[OBSERVATIONS_GLOBAL_OPERATION_LOCK_ENV.owner] === 'integrity'
      && Boolean(env[INTEGRITY_CHANNEL_ENV]) && isIntegrityCoordinator({ command, commandArgs });
    const targetEnv = { ...env };
    delete targetEnv[INTEGRITY_CHANNEL_ENV];
    if (integrity) targetEnv[INTEGRITY_CHANNEL_ENV] = env[INTEGRITY_CHANNEL_ENV];
    child = spawnProcess(command, commandArgs, {
      env: targetEnv,
      stdio: prune ? ['inherit', 'inherit', 'inherit', 'ipc']
        : integrity ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
      detached: false,
    });
    if (prune) closeAssertions = relayOriginalOperationAssertions({
      coordinator: process, child, onFailure: emergencyStop,
    });
    if (integrity) closeIntegrity = relayIntegrityAssertions({
      coordinator: process, stream: child.stdio[3],
      binding: JSON.parse(env[INTEGRITY_CHANNEL_ENV]).binding, onFailure: emergencyStop,
    });
    child.once("error", (error) => {
      finished = true;
      closeAssertions?.();
      closeIntegrity?.();
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      reportResult({ error: error instanceof Error ? error.message : String(error) });
    });
    child.once("exit", (code, signal) => {
      finished = true;
      closeAssertions?.();
      closeIntegrity?.();
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      reportResult({
        exit_code: Number(code || 0),
        target_signal: signal || null,
        stopping_signal: stoppingSignal,
      });
    });
  });
}

export async function main({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseCommand(argv);
  return await superviseLockedCommand({ ...args, env });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
